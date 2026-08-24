import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { CloudfrontWordpressEcsConstruct } from './adaptations/WordpressBehindCloudfront';

/**
 * Offline, like lib/Rds.test.ts and WordpressBehindCloudfront.test.ts. All identifiers are
 * synthetic (RFC 2606 example.com, placeholder AWS ids).
 */

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:wp-test-AbCdEf';
const PREFIX_LIST_ID = 'pl-0123456789abcdef0';
const HOSTED_ZONE = 'example.com';
const ANCHOR = `wp-test-cluster.${HOSTED_ZONE}`;

type Overrides = { autoscaling?: boolean, redis?: boolean };

const buildStack = ({ autoscaling = true, redis = true }: Overrides = {}) => {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  stack.node.setContext('stack-parms', {
    STACK_ID: 'wp-p',
    TYPE: 'cloudfront',
    PREFIXES: { wordpress: 'wp', s3proxy: 'sigv4', rds: 'rds' },
    ACCOUNT: '123456789012',
    REGION: 'us-east-1',
    AUTOSCALING: autoscaling,
    ...(redis ? { REDIS: { cacheNodeType: 'cache.t3.micro' } } : {}),
    DNS: {
      hostedZone: HOSTED_ZONE,
      crossAccountHostedZoneId: 'Z0123456789ABCDEFGHIJ',
      subdomain: ANCHOR,
      certificateARN: 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555',
      cloudfront: { challengeHeaderName: 'cloudfront-challenge' },
    },
    S3PROXY: {
      dockerImage: 'public.ecr.aws/example/aws-sigv4-proxy:latest',
      bucketUserSecretName: 'bucket-user/AccessKey',
      OLAP: 'olap-example',
      region: 'us-east-1',
    },
    WORDPRESS: {
      dockerImage: 'example/wp:tag',
      env: { dbType: 'serverless', dbName: 'wp_db', dbUser: 'root', environmentType: 'development' },
      secret: {
        wpSecretArn: SECRET_ARN,
        spSecretArn: SECRET_ARN,
        fieldNames: { dbPassword: 'password', configExtra: 'wp-config-extra' },
      },
    },
    TAGS: { Service: 'websites', Function: 'wordpress', Landscape: 'testlandscape' },
  });
  const vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
  new CloudfrontWordpressEcsConstruct(stack, 'wp-p-wp', {
    vpc,
    rdsHostName: 'db.example.com',
    ignoreRoute53: true,
    'cloudfront-prefix-id': PREFIX_LIST_ID,
    'cloudfront-challenge': 'apples',
  });
  return stack;
};

const synth = (overrides?: Overrides): Template => Template.fromStack(buildStack(overrides));

describe('AdaptableConstruct — alarms', () => {

  describe('alarms that apply regardless of autoscaling', () => {

    it.each([true, false])('creates the ECS memory alarm (autoscaling=%s)', (autoscaling) => {
      synth({ autoscaling }).hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'MemoryUtilization',
        Namespace: 'AWS/ECS',
        Threshold: 80,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 3,
      });
    });

    it('creates the ALB 5xx and unhealthy-host alarms', () => {
      const template = synth({ autoscaling: false });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'HTTPCode_Target_5XX_Count',
        Threshold: 5,
        ComparisonOperator: 'GreaterThanThreshold',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'UnHealthyHostCount',
        Threshold: 0,
        EvaluationPeriods: 2,
      });
    });
  });

  describe('task-count-at-ceiling — only meaningful with autoscaling on', () => {

    it('alarms at the same max capacity the scalable target uses', () => {
      const template = synth({ autoscaling: true });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'LiveTaskCount',
        Namespace: 'AWS/ECS',
        Threshold: 10,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 3,
      });
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MaxCapacity: 10 });
    });

    it('does not exist when autoscaling is off', () => {
      const template = synth({ autoscaling: false });
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
        .map((a: any) => a.Properties.MetricName);
      expect(alarms).not.toContain('LiveTaskCount');
    });
  });

  describe('Redis alarms — only when REDIS is configured', () => {

    it('alarms on memory percentage and any eviction', () => {
      const template = synth({ redis: true });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'DatabaseMemoryUsagePercentage',
        Namespace: 'AWS/ElastiCache',
        Threshold: 80,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Evictions',
        Namespace: 'AWS/ElastiCache',
        Threshold: 0,
        EvaluationPeriods: 1,
      });
    });

    it('does not exist when REDIS is absent', () => {
      const template = synth({ redis: false });
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
        .map((a: any) => a.Properties.MetricName);
      expect(alarms).not.toContain('DatabaseMemoryUsagePercentage');
      expect(alarms).not.toContain('Evictions');
    });
  });

  describe('shared alarm topic', () => {

    // getAlarmTopic() is lazily created and reused, not one topic per alarm.
    it('publishes every alarm to a single shared SNS topic', () => {
      const template = synth({ autoscaling: true, redis: true });
      template.resourceCountIs('AWS::SNS::Topic', 1);

      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as any[];
      expect(alarms.length).toBeGreaterThanOrEqual(6); // memory, 5xx, unhealthy, ceiling, redis x2
      alarms.forEach((a) => {
        expect(a.Properties.AlarmActions).toBeDefined();
        expect(a.Properties.AlarmActions.length).toBeGreaterThan(0);
      });
    });
  });
});
