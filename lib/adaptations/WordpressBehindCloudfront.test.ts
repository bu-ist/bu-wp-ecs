import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { CloudfrontWordpressEcsConstruct } from './WordpressBehindCloudfront';

/**
 * Covers the edge-to-origin trust boundary from synth output. Per the three-repo contract this
 * is the side that fails silent: a wrong check breaks trust in the direction nothing alarms on,
 * and mid-rotation every request returns 200 whether a sender uses the old or new value, so
 * "no failures observed" is not evidence.
 *
 * Offline like lib/Rds.test.ts, but the stack must be env-bound — an env-agnostic one fails ALB
 * creation with "Region is required to enable ELBv2 access logging".
 *
 * All identifiers here are synthetic (RFC 2606 example.com, placeholder AWS ids) so nothing in
 * this file can be copied into a live context by accident.
 */

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:wp-test-AbCdEf';
const PREFIX_LIST_ID = 'pl-0123456789abcdef0';
const HOSTED_ZONE = 'example.com';
const ANCHOR = `wp-test-cluster.${HOSTED_ZONE}`;

type Overrides = {
  subdomain?: string,
  challengePrevious?: string,
};

const buildStack = ({ subdomain = ANCHOR, challengePrevious }: Overrides = {}) => {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  stack.node.setContext('stack-parms', {
    STACK_ID: 'wp-p',
    TYPE: 'cloudfront',
    PREFIXES: { wordpress: 'wp', s3proxy: 'sigv4', rds: 'rds' },
    ACCOUNT: '123456789012',
    REGION: 'us-east-1',
    DNS: {
      hostedZone: HOSTED_ZONE,
      // Resolve by id, not by lookup, so the construct stays offline.
      crossAccountHostedZoneId: 'Z0123456789ABCDEFGHIJ',
      subdomain,
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
    'cloudfront-challenge-previous': challengePrevious,
  });
  return stack;
};

const synth = (overrides?: Overrides): Template => Template.fromStack(buildStack(overrides));

/** The wordpress container's environment, as a plain lookup. */
const containerEnv = (template: Template, name: string): string | undefined => {
  const taskDef = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0] as any;
  const container = taskDef?.Properties?.ContainerDefinitions
    ?.find((c: any) => c.Name === 'wordpress');
  return container?.Environment?.find((e: any) => e.Name === name)?.Value;
};

describe('CloudfrontWordpressEcsConstruct — the edge-to-origin boundary', () => {

  describe('the challenge listener rule', () => {

    it('forwards only on a matching challenge header', () => {
      synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: 1,
        Conditions: [{
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'cloudfront-challenge', Values: ['apples'] },
        }],
        Actions: [Match.objectLike({ Type: 'forward' })],
      });
    });

    it('accepts both values during a rotation window', () => {
      synth({ challengePrevious: 'oranges' })
        .hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
          Conditions: [Match.objectLike({
            HttpHeaderConfig: { HttpHeaderName: 'cloudfront-challenge', Values: ['apples', 'oranges'] },
          })],
        });
    });

    // A whitespace value must never become an accepted header on this boundary.
    it.each(['', '   '])('drops a blank previous value (%j)', (blank) => {
      synth({ challengePrevious: blank })
        .hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
          Conditions: [Match.objectLike({
            HttpHeaderConfig: { HttpHeaderName: 'cloudfront-challenge', Values: ['apples'] },
          })],
        });
    });
  });

  describe('the default action', () => {

    it('403s anything that does not match, and forwards to no target group', () => {
      const listeners = synth().findResources('AWS::ElasticLoadBalancingV2::Listener');
      const https = Object.values(listeners).find((l: any) => l.Properties?.Protocol === 'HTTPS') as any;

      expect(https).toBeDefined();
      expect(https.Properties.DefaultActions).toHaveLength(1);
      expect(https.Properties.DefaultActions[0]).toMatchObject({
        Type: 'fixed-response',
        FixedResponseConfig: { StatusCode: '403', ContentType: 'text/html' },
      });
      expect(https.Properties.DefaultActions[0].TargetGroupArn).toBeUndefined();
    });
  });

  describe('the ALB security group', () => {

    it('admits the CloudFront prefix list on 443 and nothing else', () => {
      const template = synth();
      const albIngress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
        .map((r: any) => r.Properties)
        .filter((p: any) => p.ToPort === 443);

      expect(albIngress).toHaveLength(1);
      expect(albIngress[0]).toMatchObject({
        IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourcePrefixListId: PREFIX_LIST_ID,
      });
      expect(albIngress[0].CidrIp).toBeUndefined();
      expect(albIngress[0].CidrIpv6).toBeUndefined();
    });

    // The CDK adds an inline default rule; an escape hatch strips it. If that ever regresses,
    // the group would carry ingress this test's standalone-resource check cannot see.
    it('carries no inline ingress rule', () => {
      Object.values(synth().findResources('AWS::EC2::SecurityGroup'))
        .forEach((sg: any) => expect(sg.Properties.SecurityGroupIngress).toBeUndefined());
    });
  });

  describe('cluster identity', () => {

    // Read once at first boot as --url to `wp core multisite-install`, then persisted in the
    // database and never re-derived. Getting it wrong is not recoverable by redeploying.
    it('installs WordPress against the anchor hostname', () => {
      const template = synth();
      expect(containerEnv(template, 'SERVER_NAME')).toEqual(ANCHOR);
      expect(containerEnv(template, 'HTTP_HOST')).toEqual(ANCHOR);
    });

    // Previously a three-field conjunction, so a blank anchor fell through to the raw ALB
    // hostname and silently pinned the install to it.
    it('refuses to build without an anchor rather than falling back to the ALB name', () => {
      expect(() => buildStack({ subdomain: '' })).toThrow(/DNS\.subdomain/);
    });
  });
});
