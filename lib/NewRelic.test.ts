import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { NewRelic } from '../context/IContext';
import { CloudfrontWordpressEcsConstruct } from './adaptations/WordpressBehindCloudfront';

/**
 * Covers the optional NEWRELIC context block: env names, the license secret reference, and the
 * execution role's read grant. Offline, like the sibling suites. All identifiers are synthetic
 * (RFC 2606 example.com, placeholder AWS ids).
 */

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:wp-test-AbCdEf';
const NR_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:newrelic/license-AbCdEf';
const HOSTED_ZONE = 'example.com';

const synth = (newRelic?: NewRelic): Template => {
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
      subdomain: `wp-test-cluster.${HOSTED_ZONE}`,
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
    ...( newRelic ? { NEWRELIC: newRelic } : {} ),
    TAGS: { Service: 'websites', Function: 'wordpress', Landscape: 'testlandscape' },
  });
  const vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
  new CloudfrontWordpressEcsConstruct(stack, 'wp-p-wp', {
    vpc,
    rdsHostName: 'db.example.com',
    ignoreRoute53: true,
    'cloudfront-prefix-id': 'pl-0123456789abcdef0',
    'cloudfront-challenge': 'apples',
  });
  return Template.fromStack(stack);
};

const wordpressContainer = (template: Template): any => {
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition')) as any[];
  return taskDefs
    .flatMap(td => td.Properties.ContainerDefinitions)
    .find((c: any) => c.Name === 'wordpress');
};

const envMap = (container: any): Record<string, any> =>
  Object.fromEntries((container.Environment ?? []).map((e: any) => [ e.Name, e.Value ]));

const secretNames = (container: any): string[] => (container.Secrets ?? []).map((s: any) => s.Name);

const NR: NewRelic = {
  enabled: true,
  appName: 'WordPress - AWS test',
  labels: 'environment:test;service:wordpress',
  licenseSecretArn: NR_SECRET_ARN,
  licenseSecretField: 'api_key',
};

describe('NEWRELIC context', () => {

  it('adds no New Relic env or secret when the block is absent', () => {
    const container = wordpressContainer(synth());
    expect(Object.keys(envMap(container)).filter(n => n.startsWith('NEW_RELIC_'))).toEqual([]);
    expect(secretNames(container)).not.toContain('NEW_RELIC_LICENSE_KEY');
  });

  it('sets the env and references the license field of the secret', () => {
    const container = wordpressContainer(synth(NR));
    const env = envMap(container);
    expect(env.NEW_RELIC_ENABLED).toBe('true');
    expect(env.NEW_RELIC_APP_NAME).toBe('WordPress - AWS test');
    expect(env.NEW_RELIC_LABELS).toBe('environment:test;service:wordpress');
    const secret = (container.Secrets as any[]).find(s => s.Name === 'NEW_RELIC_LICENSE_KEY');
    expect(secret.ValueFrom).toBe(`${NR_SECRET_ARN}:api_key::`);
  });

  it('writes NEW_RELIC_ENABLED=false and omits labels when so configured', () => {
    const env = envMap(wordpressContainer(synth({ ...NR, enabled: false, labels: undefined })));
    expect(env.NEW_RELIC_ENABLED).toBe('false');
    expect(env).not.toHaveProperty('NEW_RELIC_LABELS');
  });

  it('grants the execution role read on the license secret', () => {
    const policies = Object.values(synth(NR).findResources('AWS::IAM::Policy')) as any[];
    const grantsRead = policies.some(p => (p.Properties.PolicyDocument.Statement as any[]).some(st =>
      [].concat(st.Action).includes('secretsmanager:GetSecretValue' as never)
      && JSON.stringify(st.Resource).includes(NR_SECRET_ARN)));
    expect(grantsRead).toBe(true);
  });
});
