import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Mail } from '../context/IContext';
import { CloudfrontWordpressEcsConstruct } from './adaptations/WordpressBehindCloudfront';
import { MailConstruct } from './Mail';

/**
 * Offline, like the sibling suites. All identifiers are synthetic (RFC 2606 example.com,
 * placeholder AWS ids).
 */

const ACCOUNT = '123456789012';
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:wp-test-AbCdEf`;
const PREFIX_LIST_ID = 'pl-0123456789abcdef0';
const HOSTED_ZONE = 'example.com';
const ANCHOR = `wp-test-cluster.${HOSTED_ZONE}`;
const MAIL_ID = 'wp-p-mail-testlandscape';

const buildStack = (mail?: Mail, region = 'us-east-1') => {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: ACCOUNT, region } });
  stack.node.setContext('stack-parms', {
    STACK_ID: 'wp-p',
    TYPE: 'cloudfront',
    PREFIXES: { wordpress: 'wp', s3proxy: 'sigv4', rds: 'rds' },
    ACCOUNT,
    REGION: region,
    AUTOSCALING: false,
    DNS: {
      hostedZone: HOSTED_ZONE,
      crossAccountHostedZoneId: 'Z0123456789ABCDEFGHIJ',
      subdomain: ANCHOR,
      certificateARN: `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`,
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
  if(mail) {
    new MailConstruct(stack, MAIL_ID, { wordpress, mail });
  }
  return stack;
};

const synth = (mail?: Mail, region?: string): Template => Template.fromStack(buildStack(mail, region));

const configurationSetLogicalId = (template: Template): string =>
  Object.keys(template.findResources('AWS::SES::ConfigurationSet'))[0];

const wordpressEnv = (template: Template): Record<string, any> => {
  const taskDef: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const container = taskDef.Properties.ContainerDefinitions.find((c: any) => c.Name === 'wordpress');
  return Object.fromEntries(container.Environment.map((e: any) => [ e.Name, e.Value ]));
};

/** Every IAM policy statement that grants an SES action, with the logical ids of the roles it is attached to. */
const sesStatements = (template: Template): { statement: any, roles: string[] }[] =>
  Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy: any) =>
    policy.Properties.PolicyDocument.Statement
      .filter((s: any) => [ s.Action ].flat().some((a: string) => a.startsWith('ses:')))
      .map((statement: any) => ({ statement, roles: policy.Properties.Roles.map((r: any) => r.Ref) })));

describe('MailConstruct', () => {

  it('builds nothing when MAIL is absent from the context', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::ConfigurationSet', 0);
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 0);
    expect(sesStatements(template)).toHaveLength(0);
    expect(Object.keys(wordpressEnv(template)).filter(name => name.startsWith('BU_'))).toEqual([]);
  });

  it('builds one configuration set that suppresses bounces and complaints', () => {
    const template = synth({});
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: MAIL_ID,
      SuppressionOptions: { SuppressedReasons: [ 'BOUNCE', 'COMPLAINT' ] },
    });
  });

  it('publishes only bounce and complaint events to CloudWatch, per configuration set', () => {
    const template = synth({});
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      ConfigurationSetName: { Ref: configurationSetLogicalId(template) },
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: [ 'bounce', 'complaint' ],
        CloudWatchDestination: {
          DimensionConfigurations: [ {
            DimensionName: 'ses:configuration-set',
            DimensionValueSource: 'messageTag',
            DefaultDimensionValue: MAIL_ID,
          } ],
        },
      },
    });
  });

  it('lets the task role, not the execution role, send as bu.edu through the set', () => {
    const template = synth({});
    const grants = sesStatements(template);
    expect(grants).toHaveLength(1);

    const [ { statement, roles } ] = grants;
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatch(/TaskRole/);
    expect(roles[0]).not.toMatch(/ExecutionRole/);

    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toEqual([ 'ses:SendEmail', 'ses:SendRawEmail' ]);
    expect(statement.Condition).toEqual({ StringLike: { 'ses:FromAddress': '*@bu.edu' } });

    const resources = JSON.stringify(statement.Resource);
    expect(statement.Resource).toHaveLength(2);
    expect(resources).toContain(`:ses:us-east-1:${ACCOUNT}:identity/bu.edu`);
    expect(resources).toContain(`:configuration-set/`);
    expect(resources).toContain(JSON.stringify({ Ref: configurationSetLogicalId(template) }));
  });

  it('points the WordPress container at SES and names the set by reference', () => {
    const template = synth({});
    const env = wordpressEnv(template);
    expect(env.BU_MAIL_TRANSPORT).toBe('ses');
    expect(env.BU_SES_REGION).toBe('us-east-1');
    expect(env.BU_SES_CONFIGURATION_SET).toEqual({ Ref: configurationSetLogicalId(template) });
  });

  it('sets BU_MAIL_REDIRECT_TO only when redirectTo is set', () => {
    expect(wordpressEnv(synth({})).BU_MAIL_REDIRECT_TO).toBeUndefined();
    expect(wordpressEnv(synth({ redirectTo: 'team@example.com' })).BU_MAIL_REDIRECT_TO)
      .toBe('team@example.com');
  });

  it('sends through the stack\'s region, for the container, the identity and the configuration set', () => {
    const template = synth({}, 'us-west-2');
    expect(wordpressEnv(template).BU_SES_REGION).toBe('us-west-2');
    const [ { statement } ] = sesStatements(template);
    const resources = JSON.stringify(statement.Resource);
    expect(resources).toContain(`:ses:us-west-2:${ACCOUNT}:identity/bu.edu`);
    expect(resources).toContain(`:ses:us-west-2:${ACCOUNT}:configuration-set/`);
  });
});
