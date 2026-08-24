import { Duration, Stack } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ContainerDefinitionOptions, FargateTaskDefinition, FargateTaskDefinitionProps, ScalableTaskCount } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService as albfs, ApplicationLoadBalancedFargateServiceProps as albfsp } from 'aws-cdk-lib/aws-ecs-patterns';
import { HttpCodeTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';
import { CfnCacheCluster, CfnParameterGroup, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';

/**
 * Any fargate service will perform two steps.
 */
export interface FargateService {
  setResourceProperties() : void;
  buildResources() : void;
}

/**
 * All adaptable fargate service constructs will implement the "adapt" methods of this class to add to or 
 * modify the resources being built within. Boilerplate functionality and properties can be added here as well.
 */
/**
 * TContext names which context variant this construct serves, so subclasses that only ever
 * receive one variant read its required fields directly. Defaults to the full union.
 */
export abstract class AdaptableConstruct<TContext extends IContext = IContext> extends Construct {

  // Autoscaling floor. Also used as the ECS service's desiredCount (see Wordpress.ts), so a
  // CloudFormation-driven deploy always resets desiredCount to this same floor.
  public static AUTOSCALING_MIN_CAPACITY: number = 2;

  // Autoscaling ceiling, does what AUTOSCALING_MIN_CAPACITY does for the floor and desiredCount.
  public static AUTOSCALING_MAX_CAPACITY: number = 10;

  id: string;
  props: any;
  healthcheck: string;
  scope: Construct;
  context: TContext;
  _securityGroup: SecurityGroup;
  private _alarmTopic?: Topic;

  vpc: IVpc;
  containerDefProps: ContainerDefinitionOptions;
  taskDefProps: FargateTaskDefinitionProps;
  fargateServiceProps: albfsp;

  fargateService: albfs;

  /**
   * Most adaptation happens here since property objects are highly mutable.
   */
  abstract adaptResourceProperties(): void;

  /**
   * Some limited adaptation can happen here depending on what construct mutator methods the CDK 
   * API may provide, but most properties are readonly once the resource itself has been instantiated.
   */
  abstract adaptResources(): void;

  /**
   * Set custom autoscaling for the fargate service.
   * @returns
   */
  public setTaskAutoScaling = (): void => {
    const { AUTOSCALING=false } = this.context;
    if( ! AUTOSCALING ) return;

    const stc: ScalableTaskCount = this.fargateService.service.autoScaleTaskCount({
      // The lower boundary to which service auto scaling can adjust the desired count of the service.
      minCapacity: AdaptableConstruct.AUTOSCALING_MIN_CAPACITY,
      // The upper boundary to which service auto scaling can adjust the desired count of the service.
      maxCapacity: AdaptableConstruct.AUTOSCALING_MAX_CAPACITY
    });

    // Target Tracking
    stc.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.minutes(1),
      scaleOutCooldown: Duration.minutes(1),
    });

    stc.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.minutes(1),
      scaleOutCooldown: Duration.minutes(1),
    });

    // A clock-based floor (e.g. lower minCapacity overnight) is available via
    // stc.scaleOnSchedule() and Schedule.cron() if ever wanted, but isn't used here today.
    // Schedule.cron()'s CronOptions has no timezone field - schedules run in UTC only, with
    // no way to express local time.

    const { id, fargateService: { service } } = this;
    new Alarm(this, `${id}-task-count-ceiling-alarm`, {
      alarmName: `${id}-task-count-at-ceiling`,
      metric: new Metric({
        namespace: 'AWS/ECS',
        metricName: 'LiveTaskCount',
        dimensionsMap: { ClusterName: service.cluster.clusterName, ServiceName: service.serviceName },
        period: Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: AdaptableConstruct.AUTOSCALING_MAX_CAPACITY,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(this.getAlarmTopic()));
  }

  /**
   * One shared SNS topic per cluster for every alarm this construct creates, lazily created on
   * first use so callers don't need to sequence their calls around it.
   */
  private getAlarmTopic = (): Topic => {
    if( ! this._alarmTopic ) {
      this._alarmTopic = new Topic(this, `${this.id}-alarms-topic`, { topicName: `${this.id}-alarms` });
    }
    return this._alarmTopic;
  }

  /**
   * Alarms that apply regardless of whether autoscaling is on.
   */
  public setServiceAlarms = (): void => {
    const { id, fargateService: { service, targetGroup } } = this;
    const alarmTopic = this.getAlarmTopic();

    new Alarm(this, `${id}-ecs-memory-alarm`, {
      alarmName: `${id}-ecs-memory-high`,
      metric: service.metricMemoryUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(alarmTopic));

    new Alarm(this, `${id}-alb-5xx-alarm`, {
      alarmName: `${id}-alb-5xx`,
      metric: targetGroup.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(alarmTopic));

    new Alarm(this, `${id}-alb-unhealthy-alarm`, {
      alarmName: `${id}-alb-unhealthy-hosts`,
      metric: targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(alarmTopic));
  }

  /**
   * Set redis caching for the wordpress service.
   * @param wordpressTaskDef 
   * @returns 
   */
  public setRedisCaching = (wordpressTaskDef:FargateTaskDefinition): void => {
    const { id, vpc, context: { REDIS, TAGS: { Landscape } } } = this;
    if( ! REDIS ) return;

    const {
      cacheNodeType='cache.t3.micro',
      engineVersion,
      parameterGroupFamily='redis7',
      maxmemoryPolicy='allkeys-lru',
    } = REDIS; // Set defaults

    this._securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(6379), 'Allow inbound TCP traffic on the Redis port');
    
    // Redis doesn't need internet access, so prefer isolated subnets when available.
    // Falls back to private subnets for VPC topologies without isolated subnets.
    const redisSubnets = vpc.isolatedSubnets.length > 0 ? vpc.isolatedSubnets : vpc.privateSubnets;
    const redisSubnetGroup = new CfnSubnetGroup(this, `${id}-redis-subnet-group`, {
      description: 'Subnet group for the redis cluster.',
      subnetIds: redisSubnets.map( subnet => subnet.subnetId ),
      cacheSubnetGroupName: `${id}-${Landscape}-redis-sg`,
    });

    // The family must be compatible with the engine version, whether that version is pinned here
    // or left for ElastiCache to select.
    const redisParameterGroup = new CfnParameterGroup(this, `${id}-redis-parameter-group`, {
      cacheParameterGroupFamily: parameterGroupFamily,
      description: 'Parameter group for the redis cluster.',
      properties: { 'maxmemory-policy': maxmemoryPolicy },
    });

    // Setup properties for the redis cluster.
    // numCacheNodes is fixed at 1: ElastiCache permits >1 only for the memcached engine. Cache
    // capacity scales via cacheNodeType; replicas would require a CfnReplicationGroup instead.
    const redisClusterProps = {
      cacheNodeType,
      engine: 'redis',
      ...(engineVersion ? { engineVersion } : {}),
      numCacheNodes: 1,
      cacheParameterGroupName: redisParameterGroup.ref,
      vpcSecurityGroupIds: [ this._securityGroup.securityGroupId ],
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
    };

    // Create the redis cluster, only after the subnet group is created.
    const redisCluster = new CfnCacheCluster(this, `${id}-redis-cluster`, redisClusterProps);
    redisCluster.addDependency(redisSubnetGroup);
    redisCluster.addDependency(redisParameterGroup);

    // The wordpress container needs to find details of redis in its environment.
    const wpContainer = wordpressTaskDef.findContainer('wordpress');
    wpContainer?.addEnvironment('REDIS_HOST', redisCluster.attrRedisEndpointAddress);
    wpContainer?.addEnvironment('REDIS_PORT', redisCluster.attrRedisEndpointPort);

    const alarmTopic = this.getAlarmTopic();
    const redisMetric = (metricName: string, statistic: string) => new Metric({
      namespace: 'AWS/ElastiCache',
      metricName,
      dimensionsMap: { CacheClusterId: redisCluster.ref },
      period: Duration.minutes(5),
      statistic,
    });

    new Alarm(this, `${id}-redis-memory-alarm`, {
      alarmName: `${id}-redis-memory-high`,
      metric: redisMetric('DatabaseMemoryUsagePercentage', 'Average'),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(alarmTopic));

    new Alarm(this, `${id}-redis-evictions-alarm`, {
      alarmName: `${id}-redis-evictions`,
      metric: redisMetric('Evictions', 'Sum'),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(alarmTopic));
  }


  /**
   * Set the tags for the stack
   */
  setStackTags = () => {
    if( this.scope instanceof Stack) {
      var tags: object = this.context.TAGS;
      for (const [key, value] of Object.entries(tags)) {
        (<Stack> this.scope).tags.setTag(key, value);
      }
    }
  }
};
