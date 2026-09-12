import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { JobRunner } from '../context/IContext';
import { CloudfrontWordpressEcsConstruct } from './adaptations/WordpressBehindCloudfront';
import { JobRunnerConstruct } from './JobRunner';

/**
 * Offline, like the sibling suites. All identifiers are synthetic (RFC 2606 example.com,
 * placeholder AWS ids).
 */

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:wp-test-AbCdEf';
const PREFIX_LIST_ID = 'pl-0123456789abcdef0';
const HOSTED_ZONE = 'example.com';
const ANCHOR = `wp-test-cluster.${HOSTED_ZONE}`;

const buildStack = (jobRunner?: JobRunner) => {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  stack.node.setContext('stack-parms', {
    STACK_ID: 'wp-p',
    TYPE: 'cloudfront',
    PREFIXES: { wordpress: 'wp', s3proxy: 'sigv4', rds: 'rds' },
    ACCOUNT: '123456789012',
    REGION: 'us-east-1',
    AUTOSCALING: false,
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
  const wordpress = new CloudfrontWordpressEcsConstruct(stack, 'wp-p-wp', {
    vpc,
    rdsHostName: 'db.example.com',
    ignoreRoute53: true,
    'cloudfront-prefix-id': PREFIX_LIST_ID,
    'cloudfront-challenge': 'apples',
  });
  if(jobRunner) {
    new JobRunnerConstruct(stack, 'wp-p-jobs-testlandscape', { wordpress, jobRunner });
  }
  return stack;
};

const synth = (jobRunner?: JobRunner): Template => Template.fromStack(buildStack(jobRunner));

const scheduleProps = (template: Template): any =>
  (Object.values(template.findResources('AWS::Scheduler::Schedule'))[0] as any)?.Properties;

describe('JobRunnerConstruct', () => {

  it('builds no schedule when JOBRUNNER is absent from the context', () => {
    synth().resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  it('builds exactly one schedule carrying the configured expression', () => {
    const template = synth({ schedule: 'rate(3 minutes)' });
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    expect(scheduleProps(template).ScheduleExpression).toBe('rate(3 minutes)');
  });

  // The reason timeZone exists: a cron window expressed in UTC drifts an hour twice a year.
  it('passes the time zone through for a cron window', () => {
    const props = scheduleProps(synth({
      schedule: 'cron(0/3 7-20 ? * MON-FRI *)', timeZone: 'America/New_York',
    }));
    expect(props.ScheduleExpression).toBe('cron(0/3 7-20 ? * MON-FRI *)');
    expect(props.ScheduleExpressionTimezone).toBe('America/New_York');
  });

  it('defaults to enabled, and honours enabled: false', () => {
    expect(scheduleProps(synth({ schedule: 'rate(3 minutes)' })).State).toBe('ENABLED');
    expect(scheduleProps(synth({ schedule: 'rate(3 minutes)', enabled: false })).State).toBe('DISABLED');
  });

  // Running on the service's own security group is what makes the Redis and RDS ingress rules
  // already cover this task; a group of its own would need both rules restated.
  it('runs the task privately, on the WordPress service security group', () => {
    const template = synth({ schedule: 'rate(3 minutes)' });
    const net = scheduleProps(template)
      .Target.EcsParameters.NetworkConfiguration.AwsvpcConfiguration;

    expect(net.AssignPublicIp).toBe('DISABLED');
    expect(net.Subnets.length).toBeGreaterThan(0);

    const fargateSgLogicalId = Object.keys(template.findResources('AWS::EC2::SecurityGroup'))
      .find(k => k.includes('fargatesg'));
    expect(net.SecurityGroups).toEqual([ { 'Fn::GetAtt': [ fargateSgLogicalId, 'GroupId' ] } ]);
  });

  it('overrides the WordPress container command to drain the job queue', () => {
    const input = JSON.parse(scheduleProps(synth({ schedule: 'rate(3 minutes)' })).Target.Input);
    expect(input.containerOverrides).toHaveLength(1);
    expect(input.containerOverrides[0].name).toBe('wordpress');
    expect(input.containerOverrides[0].command).toEqual(
      [ 'wp', 'site-manager', 'process-jobs', '--stay-open' ]);
  });

  // Reusing the service's task definition is what makes the security group reuse correct;
  // a definition of its own would need its own ingress rules.
  it('reuses the WordPress task definition rather than defining its own', () => {
    const template = synth({ schedule: 'rate(3 minutes)' });
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  });
});
