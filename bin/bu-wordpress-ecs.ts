#!/usr/bin/env node
import { App, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, IVpc, Vpc } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CustomResourceConfig } from 'aws-cdk-lib/custom-resources';
import { CloudfrontContext, DEPLOYMENT_TYPES, IContext, SecretFieldNames } from '../context/IContext';
import { checkIamServerCertificate } from '../lib/Certificate';
import { ContextLog } from '../context/ContextLog';
import { JobRunnerConstruct } from '../lib/JobRunner';
import { BuWordpressRdsConstruct as RdsConstruct } from '../lib/Rds';
import { SecretsManagerSecret } from '../lib/Secret';
import { BU_NameTagAspect, TaggingAspect } from '../lib/Tagging';
import { getStackName, logHeader } from '../lib/Utils';
import { StandardWordpressConstruct, WordpressEcsConstruct } from '../lib/Wordpress';
import { CloudfrontWordpressEcsConstruct, lookupCloudfrontHeaderChallenge, lookupCloudfrontPrefixListId } from '../lib/adaptations/WordpressBehindCloudfront';
import { SelfSignedWordpressEcsConstruct } from '../lib/adaptations/WordpressSelfSigned';
import { ContainerModShibWordpressEcsConstruct } from '../lib/adaptations/WordpressWithHostedZone';
import { Route53HostedZone } from './Route53';


/**
 * Ensure the secret parameter is defined and refers to an existing secret
 * @param parm 
 */
const validateSecret = async (parm: { fldName:string, secretArn: string, region: string }): Promise<void> => {
  const { fldName, secretArn, region } = parm;

  let msg = fldName.includes('wp') ?
    `\nYou can create and upload it to secrets manager by populating the ./.env file as ` +
    `\ndirected in the README and running "npm run create-secrets".` :
    `\nHelper scripts to create and upload this secret to secrets manager are available ` +
    `\nin the bu-lambda-shibboleth repository as directed in its README.`;

  // Make sure the secretArn is defined and refers to an existing secret
  if( secretArn ) {
    const exists = await new SecretsManagerSecret({ 
      secretName: secretArn, fldNames: {} as SecretFieldNames, region 
    }).exists();

    // Abort if the specified secret does not exist
    if( ! exists ) {
      logHeader('VALIDATION ERROR!!!');
      console.error(`The secret ${secretArn} does not exist as specified in ${fldName}. ` + msg);
      process.exit(1);
    }
  }
  else {
    logHeader('VALIDATION ERROR!!!');
    console.error(`${fldName} must be defined in the context file. ` + msg);
    process.exit(1);
  }
}

/**
 * Define a helper function to lookup cloudfront parameters indicating custom headers for shib-sp integration
 * @param context 
 * @returns 
 */
const lookupCloudfrontParameters = async (context:CloudfrontContext) => {
  const { WORDPRESS: { secret: { spSecretArn } }, REGION: region, DNS: { cloudfront: { challengeHeaderName } } } = context;
  const prefixId = await lookupCloudfrontPrefixListId(region);
  const challenge = await lookupCloudfrontHeaderChallenge(spSecretArn, challengeHeaderName);
  // During a challenge-rotation window the secret also carries a `<header>-previous` field; it is absent
  // otherwise, in which case this resolves to undefined and the ALB rule collapses to just the current
  // value (no behavior change). Plumbed through so the listener can accept both while senders are flipped
  // independently, in any order.
  const challengePrevious = await lookupCloudfrontHeaderChallenge(spSecretArn, `${challengeHeaderName}-previous`);
  return {
    'cloudfront-prefix-id': prefixId,
    'cloudfront-challenge': challenge,
    'cloudfront-challenge-previous': challengePrevious,
  };
};

/**
 * Find out if an A record for the subdomain already exists AND was not created by this stack.
 * @param context 
 * @returns 
 */
const ignoreRoute53 = async (context:CloudfrontContext): Promise<boolean> => {
  const { DNS: { hostedZone, subdomain } } = context;

  if( subdomain && hostedZone ) {
    const route53HostedZone: Route53HostedZone = new Route53HostedZone(context);
    const record = await route53HostedZone.findARecord(subdomain);
    const { createdByThisStack, recordSet } = record ?? {};
    if(recordSet) {
      return ! createdByThisStack;
    }
  }
  return true;
}


(async () => {
  // Instatiate the app
  const app = new App();

  // Configure custom resource defaults
  CustomResourceConfig.of(app).addRemovalPolicy(RemovalPolicy.DESTROY);
  CustomResourceConfig.of(app).addLogRetentionLifetime(RetentionDays.ONE_WEEK);

  // Load context file based on -c env=<name> parameter, defaulting to context.json
  const envName = app.node.tryGetContext('env');
  const contextFileName = envName ? `context-${envName}` : 'context';
  let ctx: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctx = require(`../context/${contextFileName}.json`);
  } catch (err) {
    console.error(`Failed to load context file: context/${contextFileName}.json`);
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
  const context = ctx as IContext;
  
  app.node.setContext('stack-parms', context);

  // Deconstruct the context
  const { 
    ACCOUNT:account, REGION:region, STACK_ID, VPC,
    TAGS: { Service, Function, Landscape, CostCenter='', Ticket='' }, 
    PREFIXES: { wordpress:pfxWordpress, rds:pfxRds },
    WORDPRESS: { secret: { spSecretArn, wpSecretArn }}
  } = context;


  // Validate the wordpress secret
  await validateSecret({ fldName:'WORDPRESS.secret.wpSecretArn', secretArn: wpSecretArn, region });
  
  // Validate the secret for shib-sp details 
  await validateSecret({ fldName:'WORDPRESS.secret.spSecretArn', secretArn: spSecretArn, region });

  // Define the stack properties
  const stackProps: StackProps = {
    stackName: getStackName(context),
    description: 'Fargate ECS cluster for wordpress, s3proxy, and rds',
    env: { account, region },
    tags: { Service, Function, Landscape, Ticket, CostCenter }
  }

  // Define properties
  const wpId = `${STACK_ID}-${pfxWordpress}`;
  const rdsId = `${STACK_ID}-${pfxRds}`;
  const stack = new Stack(app, 'StandardStack', stackProps);
  const ipAddresses = IpAddresses.cidr('10.0.0.0/21');
  const availabilityZones = [ `${region}a`, `${region}b`];
  
  // VPC: Use existing VPC if specified, otherwise create new VPC with standard defaults
  const vpc: IVpc = VPC?.existingVpcId 
    ? Vpc.fromLookup(stack, `${STACK_ID}-vpc`, { vpcId: VPC.existingVpcId })
    : new Vpc(stack, `${STACK_ID}-vpc`, { ipAddresses, availabilityZones });
  
  // Define the RDS construct
  const rds = new RdsConstruct(stack, rdsId, { vpc });
  const { endpointAddress:rdsHostName } = rds;

  let ecs:WordpressEcsConstruct;

  switch(context.TYPE) {
    case 'cloudfront':
      console.log(`NOTICE: TYPE "cloudfront" -> CloudfrontWordpressEcsConstruct`);
      ecs = new CloudfrontWordpressEcsConstruct(stack, wpId, {
        vpc,
        rdsHostName,
        distributionDomainName: context.DNS.cloudfront.distributionDomainName ?? '',
        ignoreRoute53: await ignoreRoute53(context),
        ...(await lookupCloudfrontParameters(context))
      });
      break;
    case 'self-signed':
      console.log(`NOTICE: TYPE "self-signed" -> SelfSignedWordpressEcsConstruct`);
      ecs = new SelfSignedWordpressEcsConstruct(stack, wpId, {
        vpc, rdsHostName, iamServerCertArn: (await checkIamServerCertificate())
      });
      break;
    case 'container-mod-shib':
      console.log(`NOTICE: TYPE "container-mod-shib" -> ContainerModShibWordpressEcsConstruct`);
      ecs = new ContainerModShibWordpressEcsConstruct(stack, wpId, { vpc, rdsHostName });
      break;
    case 'non-public':
      console.log(`NOTICE: TYPE "non-public" -> StandardWordpressConstruct`);
      console.log("WARNING: This fargate service will not be publicly addressable. " +
        "Some modification after stack creation will be required.");
      ecs = new StandardWordpressConstruct(stack, wpId, { vpc, rdsHostName });
      break;
    default:
      console.error(`Invalid TYPE in context/${contextFileName}.json: ` +
        `${JSON.stringify((context as IContext).TYPE)}. Must be one of: ${DEPLOYMENT_TYPES.join(', ')}`);
      process.exit(1);
  }

  // Grant wordpress access to the database
  rds.addSecurityGroupIngressTo(ecs.securityGroup.securityGroupId);

  // Add an optional job runner construct if specified in the context.
  if(context.JOBRUNNER) {
    new JobRunnerConstruct(stack, `${STACK_ID}-jobs-${Landscape}`, {
      wordpress: ecs, jobRunner: context.JOBRUNNER
    });
  }


  // Store the context configuration using ContextLog (S3 storage)
  // NOTE: If you want to change the id of this construct or name of the bucket, you must first
  // redeploy with this code commented out (to remove it), then uncomment and redeploy again 
  // to avoid cloudformation errors.
  new ContextLog(stack, `${STACK_ID}-context`, { context, stackName:getStackName(context) });

  // Apply standard tags to all resources in each stack
  // SEE: https://github.com/bu-ist/buaws-istcloud-information/blob/main/aws-tagging-standard.md#costcenter
  // NOTE: The CostCenter value is "AWS Word Press Migration to AWS", not "AWS WordPress Migration to AWS"
  const standardTags = { 
    Service, 
    Function, 
    Landscape, 
    CostCenter, 
    Ticket 
  };
  new TaggingAspect(stack, standardTags).applyTags({ 
    aspect: new BU_NameTagAspect(standardTags) 
  });
  
})();

   

