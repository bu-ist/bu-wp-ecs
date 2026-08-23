import { Duration, Stack } from 'aws-cdk-lib';
import { Schedule } from 'aws-cdk-lib/aws-applicationautoscaling';
import { IVpc, Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ContainerDefinitionOptions, FargateTaskDefinition, FargateTaskDefinitionProps, ScalableTaskCount } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService as albfs, ApplicationLoadBalancedFargateServiceProps as albfsp } from 'aws-cdk-lib/aws-ecs-patterns';
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

  id: string;
  props: any;
  healthcheck: string;
  scope: Construct;
  context: TContext;
  _securityGroup: SecurityGroup;

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
      minCapacity: 2,
      // The upper boundary to which service auto scaling can adjust the desired count of the service.
      maxCapacity: 10
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

    /**
     * Scheduled adjustment to the minimum number of tasks required.
     * This will effectively neutralize any target tracking scaling that attempts to reduce the task count
     * down to 1 task by maintaining a lower limit of 2.  
     */
    stc.scaleOnSchedule('WorkDayMorningScaleUp', {
      schedule: Schedule.cron({ hour: '8', minute: '0', weekDay: '1-5' }),
      minCapacity: 2
    });
    /**
     * Scheduled adjustment to the minimum number of tasks required.
     * This will effectively enable any target tracking scaling that wants to reduce the task count
     * down to 1 task.  
     */
    stc.scaleOnSchedule('WorkDayEveningScaleDown', {
      schedule: Schedule.cron({ hour: '20', minute: '0', weekDay: '1-5' }),
      minCapacity: 1
    });  
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
