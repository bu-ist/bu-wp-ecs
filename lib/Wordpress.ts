import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerDefinitionOptions, ContainerInsights, FargateTaskDefinition, PropagatedTagSource } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService as albfs, ApplicationLoadBalancedFargateServiceProps as albfsp } from 'aws-cdk-lib/aws-ecs-patterns';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';
import { AdaptableConstruct, FargateService } from './AdaptableFargateService';
import { ParameterTester } from './Utils';
import { WordpressAppContainerDefConfig } from './WordpressAppContainerDefConfig';
import { WordpressS3ProxyContainerDefConfig } from './WordpressS3ProxyContainerDefConfig';

/**
 * Baseline class for the wordpresss application load balanced fargate service.
 * Subclasses will "adapt" this baseline in order to customize it. 
 */
export abstract class WordpressEcsConstruct<TContext extends IContext = IContext>
  extends AdaptableConstruct<TContext> implements FargateService {

  private sidecarContainerDefProps: ContainerDefinitionOptions;
  
  constructor(scope: Construct, id: string, props?: any) {    

    super(scope, id);

    this.scope = scope;
    this.context = scope.node.getContext('stack-parms');
    this.id = id;
    this.props = props;
    this.healthcheck = '/healthcheck.htm';
    this.vpc = props.vpc;

    this.setResourceProperties();

    this.adaptResourceProperties();

    this.buildResources();

    this.adaptResources();
  }

  setResourceProperties(): void {

    const { id, vpc, context: { TAGS: { Landscape }, STACK_ID: stackId, S3PROXY, AUTOSCALING } } = this;

    this.containerDefProps = new WordpressAppContainerDefConfig().getProperties(this);

    if(S3PROXY) {
      this.sidecarContainerDefProps = new WordpressS3ProxyContainerDefConfig().setPrefix('s3proxy').getProperties(this);
    }
    
    this.taskDefProps = { family: id, cpu: 1024, memoryLimitMiB: 2048, };

    this._securityGroup = new SecurityGroup(this, `${id}-fargate-sg`, {
      vpc, 
      securityGroupName: `${stackId}-fargate-${Landscape}-sg`,
      description: 'Allows for ingress to the wordpress rds db from ecs tasks and selected vpn subnets.',
      allowAllOutbound: true,
    });

    const clusterName = `${id}-cluster-${Landscape}`;

    // Create a log group with the anticipated name of the log group Container Insights would create automatically.
    // This ensures the log group will not survive stack deletion, and retention policy can be controlled.
    new LogGroup(this, 'ContainerInsightsPerformanceLog', {
      logGroupName: `/aws/ecs/containerinsights/${clusterName}/performance`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });
    
    this.fargateServiceProps = {
      serviceName: `${id}-service-${Landscape}`,
      cluster: new Cluster(this, `${id}-cluster`, {
        clusterName,
        containerInsightsV2: ContainerInsights.ENABLED,
        // ContainerInsights.ENHANCED can generate 10-20x more metrics than standard Container Insights, 
        // so the CloudWatch costs can be significantly higher.
        vpc
      }),
      enableExecuteCommand: true, // Enable shell access
      loadBalancerName: `${id}-fargate-alb`,
      desiredCount: AUTOSCALING ? AdaptableConstruct.AUTOSCALING_MIN_CAPACITY : 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      propagateTags: PropagatedTagSource.TASK_DEFINITION,
      capacityProviderStrategies: [ { capacityProvider: 'FARGATE', base: 1, weight: 1 } ],
      securityGroups: [ this._securityGroup ],
      assignPublicIp: false,
      healthCheckGracePeriod: Duration.seconds(15),
      publicLoadBalancer: false,
    } as albfsp;
  }

  buildResources(): void {

    const { scope, id, fargateServiceProps, containerDefProps, context: { DNS, S3PROXY }, setTaskAutoScaling, setStackTags,
       setRedisCaching, setServiceAlarms, sidecarContainerDefProps: _sidecarContainerDefProps, taskDefProps, healthcheck } = this;

    setStackTags();

    const wordpressTaskDef = new FargateTaskDefinition(this, `${id}-taskdef`, taskDefProps);

    wordpressTaskDef.addContainer(`${id}-taskdef-wp`, containerDefProps);

    if(S3PROXY) {
      wordpressTaskDef.addContainer(`${id}-taskdef-s3proxy`, _sidecarContainerDefProps);
    }

    this.fargateService = new albfs(
      this, `${id}-fargate-service`, 
      Object.assign(fargateServiceProps, { taskDefinition: wordpressTaskDef } )
    );

    const { fargateService: { loadBalancer, targetGroup, service: { taskDefinition } } } = this;

    targetGroup.configureHealthCheck({
      path: healthcheck,
      healthyThresholdCount: 3,
      unhealthyThresholdCount: 10, // default 2
      interval: Duration.seconds(15), // default 30 seconds
      healthyHttpCodes: '200-299',
    });
    
    // Get the ALB to log to a bucket
    loadBalancer.logAccessLogs(new Bucket(this, `${id}-alb-access-logs`, {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    }));

    /**
     * Grant the task definition the ability to Pull images from the account ecr.
     * 
     * IMPORTANT! 
     * While the execution role has a wildcard granting the task definition the 
     * ability to attempt pulling images from any ECR specified, if the target image 
     * is in an ECR repository in another account, that account must have a resource
     * based policy on the repository granting pull access to this account:
     * 
     * {
        "Version": "2012-10-17", 
        "Statement": [
          {
            "Effect": "Allow",
            "Principal": {
              "AWS": "arn:aws:iam::PULLING-ACCOUNT-ID:root"
            },
            "Action": [
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage", 
              "ecr:BatchCheckLayerAvailability"
            ]
          }
        ]
      }
     */
    taskDefinition.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [ '*' ],
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:GetAuthorizationToken',
      ]
    }));

    const { isNotBlank } = ParameterTester;
    const { subdomain } = DNS || {};

    // SERVER_NAME is read once, at first boot, by the image entrypoint and passed as --url to
    // `wp core multisite-install`. It lands in the database and is never re-derived, so this is
    // the cluster's persistent notion of self, not just a hostname.
    if(isNotBlank(subdomain)) {
      wordpressTaskDef.findContainer('wordpress')?.addEnvironment('HTTP_HOST', subdomain!);
      wordpressTaskDef.findContainer('wordpress')?.addEnvironment('SERVER_NAME', subdomain!);
      new CfnOutput(scope, 'CloudFrontDistributionURL', {
        value: `https://${subdomain}`,
        description: 'CloudFront Distribution URL',
      });
    }
    else {
      wordpressTaskDef.findContainer('wordpress')?.addEnvironment('HTTP_HOST', loadBalancer.loadBalancerDnsName);
      wordpressTaskDef.findContainer('wordpress')?.addEnvironment('SERVER_NAME', loadBalancer.loadBalancerDnsName);
    }

    setTaskAutoScaling();

    setServiceAlarms();

    setRedisCaching(wordpressTaskDef);
  }

  public get securityGroup(): SecurityGroup {
    return this._securityGroup;
  }
}


/**
 * "Clean sheet of paper" baseline that models aws recommended best practices.
 * Provides a "standard" deployment of this construct as one would conduct in an unconstrained aws account, accepting most defaults.
 * NOTE: This construct does not currently provide any public access to the fargate service.
 */
export class StandardWordpressConstruct extends WordpressEcsConstruct {
  adaptResourceProperties(): void { /* Do nothing */ }
  adaptResources(): void { /* Do nothing */ }
};

