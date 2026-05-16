#!/usr/bin/env node
import { App, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, IVpc, Vpc } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CustomResourceConfig } from 'aws-cdk-lib/custom-resources';
import { IContext, SecretFieldNames } from '../context/IContext';
import * as ctx from '../context/context.json';
import { checkIamServerCertificate } from '../lib/Certificate';
import { ContextLog } from '../context/ContextLog';
import { BuWordpressRdsConstruct as RdsConstruct } from '../lib/Rds';
import { SecretsManagerSecret } from '../lib/Secret';
import { BU_NameTagAspect, TaggingAspect } from '../lib/Tagging';
import { getStackName, logHeader } from '../lib/Utils';
import { StandardWordpressConstruct, WordpressEcsConstruct } from '../lib/Wordpress';
import { CloudfrontWordpressEcsConstruct, lookupCloudfrontHeaderChallenge, lookupCloudfrontPrefixListId } from '../lib/adaptations/WordpressBehindCloudfront';
import { SelfSignedWordpressEcsConstruct } from '../lib/adaptations/WordpressSelfSigned';
import { HostedZoneForALBWordpressEcsConstruct, HostedZoneForCloudfrontWordpressEcsConstruct } from '../lib/adaptations/WordpressWithHostedZone';
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
const lookupCloudfrontParameters = async (context:IContext) => {
  const { WORDPRESS: { secret: { spSecretArn } }, REGION: region, DNS: { cloudfront: { challengeHeaderName='' } = {} } = {} } = context;
  const prefixId = await lookupCloudfrontPrefixListId(region);
  const challenge = await lookupCloudfrontHeaderChallenge(spSecretArn, challengeHeaderName);
  return { 'cloudfront-prefix-id':prefixId, 'cloudfront-challenge':challenge };
};

/**
 * Find out if an A record for the subdomain already exists AND was not created by this stack.
 * @param context 
 * @returns 
 */
const ignoreRoute53 = async (context:IContext): Promise<boolean> => {
  const { DNS: { hostedZone, subdomain } = {} } = context;

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

  const context = ctx as IContext;
  
  app.node.setContext('stack-parms', context);

  // Deconstruct the context
  const { 
    ACCOUNT:account, REGION:region, STACK_ID, VPC, DNS,
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
  
  const { hostedZone, certificateARN, cloudfront, cloudfront: {distributionDomainName='' } = {} } = DNS ?? {};

  // Define the RDS construct
  const rds = new RdsConstruct(stack, rdsId, { vpc });
  const { endpointAddress:rdsHostName } = rds;

  let ecs:WordpressEcsConstruct;

  if( ! certificateARN) {
    // Define an ECS construct that routes https via a self-signed iam certificate.
    ecs = new SelfSignedWordpressEcsConstruct(stack, wpId, { 
      vpc, rdsHostName, iamServerCertArn: (await checkIamServerCertificate())
    });
  }
  else if(distributionDomainName && hostedZone) {
    // Define an ECS construct that is routed to through a pre-existing cloudfront distribution via route53.
    ecs = new HostedZoneForCloudfrontWordpressEcsConstruct({
      baseline: stack,
      id: wpId,
      props: { 
        vpc, 
        rdsHostName, 
        ignoreRoute53: await ignoreRoute53(context), 
        ...(await lookupCloudfrontParameters(context)) 
      },
      distributionDomainName
    });
  }
  else if(cloudfront && ! hostedZone) {
    // Define an ECS construct that accepts traffic only from a pre-existing cloudfront distribution 
    // on its default domain that is configured to route to the ALB created by the fargate construct.
    ecs = new CloudfrontWordpressEcsConstruct(stack, wpId, { 
      vpc, rdsHostName, ...(await lookupCloudfrontParameters(context))
    });
  }
  else if(hostedZone) {
    // Define an ECS construct that routes through the auto-created ALB of the fargate construct via route53.
    ecs = new HostedZoneForALBWordpressEcsConstruct(stack, wpId, { vpc, rdsHostName });
  }
  else {
    // Define a standard ECS construct that is not publicly addressable.
    console.log("WARNING: This fargate service will not be publicly addressable. " + 
      "Some modification after stack creation will be required.");
    ecs = new StandardWordpressConstruct(stack, wpId, { vpc, rdsHostName });
  }

  // Grant wordpress access to the database
  rds.addSecurityGroupIngressTo(ecs.securityGroup.securityGroupId);
      
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

   

