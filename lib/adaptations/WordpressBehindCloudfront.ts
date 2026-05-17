import { DescribeManagedPrefixListsCommand, DescribeManagedPrefixListsRequest, DescribeManagedPrefixListsResult, EC2Client } from "@aws-sdk/client-ec2";
import { GetSecretValueCommand, GetSecretValueCommandOutput, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Stack } from "aws-cdk-lib";
import { Certificate, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { CfnSecurityGroup, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { ApplicationListener, ApplicationLoadBalancer, ApplicationLoadBalancerProps, CfnListener, ListenerAction, ListenerCondition } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ApplicationLoadBalancedFargateServiceProps, ApplicationLoadBalancedServiceRecordType } from "aws-cdk-lib/aws-ecs-patterns";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { Route53HostedZone } from '../../bin/Route53';
import { ParameterTester } from "../Utils";
import { WordpressEcsConstruct } from "../Wordpress";
import { WordpressAppContainerDefConfig } from "../WordpressAppContainerDefConfig";

/**
 * CloudFront-fronted WordPress deployment with Lambda@Edge SAML authentication.
 * A pre-existing CloudFront distribution is configured to point at the ALB created by this
 * stack as one of its origins. Optionally includes Route53 A record for custom domain.
 * Container does NOT redirect HTTP to HTTPS (CloudFront handles TLS termination).
 */
export class CloudfrontWordpressEcsConstruct extends WordpressEcsConstruct {

  alb: ApplicationLoadBalancer;
  
  constructor(baseline: Stack, id: string, props?: any) {
    super(baseline, id, props);
  }

  /**
   * Enforce singleton pattern for hosted zone construct to avoid name collisions.
   * Returns hosted zone if Route53 integration is configured.
   */
  private getDomainZone(): IHostedZone | undefined {
    const { context: { DNS: { hostedZone:domainName = '', crossAccountHostedZoneId } = {} } } = this;
    
    // No hosted zone configured
    if (!domainName) return undefined;
    
    // Return cached zone if already looked up
    if (this.props.domainZone) return this.props.domainZone;
    
    // Cross-account hosted zone
    if (crossAccountHostedZoneId) {
      this.props.domainZone = HostedZone.fromHostedZoneId(
        this, 
        'CrossAccountZone', 
        crossAccountHostedZoneId
      ) satisfies IHostedZone;
    }
    // Same-account hosted zone lookup
    else {
      this.props.domainZone = HostedZone.fromLookup(this, 'Zone', { domainName }) satisfies IHostedZone;
    }
    
    return this.props.domainZone;
  }

  adaptResourceProperties(): void {

    const {  id, vpc, props, context: { STACK_ID, DNS, TAGS: { Landscape } } } = this;

    /** Create the one security group for the ALB, which should only allow inbound requests from cloudfront */
    const { SSL_HOST_PORT:httpsPort } = WordpressAppContainerDefConfig;
    const securityGroup = new SecurityGroup(this, `${id}-alb-sg`, {
      vpc, 
      allowAllOutbound: true, 
      description: `Allow ingress from cloudfront on port ${httpsPort}`,
    });
    const prefixListId = props['cloudfront-prefix-id'];

    securityGroup.addIngressRule(Peer.prefixList(prefixListId), Port.tcp(httpsPort));

    /**
     * Override auto-creation of the ALB by the CDK fargate construct and create it explicitly here.
     * It must be public because cloudfront cannot reach it otherwise. However, you can still lock down ingress 
     * to cloudfront only via the security group. Also, consider: 
     *   https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html
     */
    this.alb = new ApplicationLoadBalancer(this, `${id}-alb`, {
      vpc, 
      internetFacing: true,
      loadBalancerName: `${id}-alb-${Landscape}`,      
      securityGroup
    } as ApplicationLoadBalancerProps);

    /**
     * Have to create an escape hatch here because the cdk always adds a default inline ingress rule to the sg
     * We do not want this ingress rule - we only want the cloudfront ingress rule, so removing it here.
     */
    const sg = securityGroup.node.defaultChild as CfnSecurityGroup;
    sg.addPropertyDeletionOverride('SecurityGroupIngress');
    
    // Route53 integration (optional)
    const { hostedZone, certificateARN:certArn = '', subdomain } = DNS || {};
    if (hostedZone) {
      // Bind getDomainZone to this context
      this.getDomainZone = this.getDomainZone.bind(this);
      
      // Cannot proceed without a certificate for Route53 integration
      if (!certArn) {
        throw new Error('You must include an SSL certificate ARN if using Route53 with CloudFront');
      }

      // Look up the hosted zone and certificate
      const domainZone = this.getDomainZone();
      const certificate = Certificate.fromCertificateArn(this, `${id}-acm-cert`, certArn) satisfies ICertificate;

      // Configure fargate service with Route53 integration
      // Prevent CDK from automatically adding an A record to the hosted zone for the ALB
      const recordType = ApplicationLoadBalancedServiceRecordType.NONE;

      Object.assign(this.fargateServiceProps, { 
        certificate, 
        redirectHTTP: true,
        recordType: recordType,
        publicLoadBalancer: true,
        loadBalancer: this.alb,
      } as ApplicationLoadBalancedFargateServiceProps);

      if (subdomain) {
        Object.assign(this.fargateServiceProps, {
          domainZone,
          domainName: subdomain
        } as ApplicationLoadBalancedFargateServiceProps);
      }
    }
  }

  adaptResources(): void {
    const { loadBalancer: { listeners }, targetGroup } = this.fargateService
    const { isBlank } = ParameterTester;
    const { challengeHeaderName } = this.context?.DNS?.cloudfront!;
    const challengeHeaderValue = this.props['cloudfront-challenge'];
    if(isBlank(challengeHeaderName)) {
      throw new Error('The alb challenge header name has not been set in context.json');
    }
    if(isBlank(challengeHeaderValue)) {
      throw new Error('The alb challenge header value was not provided (Did the lookup fail?)');
    }
    
    // Find the https listener.
    const httpsListener = listeners.find((listener:ApplicationListener) => {
      return `${listener['protocol']}`.toLowerCase() == 'https';
    }) || {} as ApplicationListener;
    
    // Apply a rule to the listener making it only forward traffic if the expected cloudfront challenge 
    // header is present and has the expected value.
    httpsListener.addAction(`${this.id}-listener-action`, {
      action: ListenerAction.forward([ targetGroup ]),
      conditions: [ ListenerCondition.httpHeader(challengeHeaderName, [ challengeHeaderValue ]) ],
      priority: 1
    });

    // Disable the default listener rule so that the new "challenge" rule is the only rule that
    // applies for the listener. This requires an escape hatch.
    const defaultListener = httpsListener.node.defaultChild as CfnListener;
    defaultListener.addPropertyOverride('DefaultActions.0.Type', 'fixed-response');
    defaultListener.addPropertyDeletionOverride('DefaultActions.0.TargetGroupArn');
    const fixedResponseConfig = {
      ContentType: 'text/html',
      MessageBody: 'Access denied',
      StatusCode: '403'
    };
    defaultListener.addPropertyOverride('DefaultActions.0.FixedResponseConfig', fixedResponseConfig);
    
    // Route53 A record creation (optional, only if Route53 integration configured)
    const { id, props: { ignoreRoute53 = false }, context: { DNS: { 
      hostedZone, subdomain, cloudfront: { distributionDomainName = '' } = {} 
    } = {} } } = this;
    
    if (hostedZone && !ignoreRoute53) {
      if (!subdomain) {
        console.warn('A subdomain was not provided; using root domain for hosted zone.');
      }
      
      const route53HostedZone: Route53HostedZone = new Route53HostedZone(this.context);
      route53HostedZone.createARecord({
        scope: this,
        id: `${id}-cloudfront-alias-record`,
        distributionDomainName,
        hostedZone,
        recordName: subdomain ?? ''
      });
    } else if (hostedZone && ignoreRoute53) {
      console.log(`Ignoring route53 record creation for subdomain ${subdomain} in hosted zone ${hostedZone}`);
    }
  }
}


/**
 * Use the sdk to lookup the id for the cloudfront prefix list.
 * @returns 
 */
export async function lookupCloudfrontPrefixListId(region:string): Promise<string|undefined> {
  console.log('Looking up prefix list ID for cloudfront...');
  const client = new EC2Client({ region });
  const command = new DescribeManagedPrefixListsCommand({
    Filters: [
      { Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }
    ]
  } as DescribeManagedPrefixListsRequest);  
  const response = await client.send(command) as DescribeManagedPrefixListsResult;
  return response?.PrefixLists![0].PrefixListId;
}

/**
 * Lookup the cloudfront header challenge value in secrets manager.
 * @param spSecretArn The arn of the secrets manager secret containing the cloudfront header challenge.
 * @param secretFld The field name in the secret containing the challenge value.
 * @returns 
 */
export const lookupCloudfrontHeaderChallenge = async (spSecretArn:string, secretFld:string) => {
  const command = new GetSecretValueCommand({ SecretId: spSecretArn });
  const region = spSecretArn.split(':')[3];
  const secretsClient = new SecretsManagerClient({ region });
  const response:GetSecretValueCommandOutput = await secretsClient.send(command);
  if( ! response.SecretString) {
    throw new Error('Empty/missing cloudfront header challenge!');
  }
  const fieldset = JSON.parse(response.SecretString);
  const challenge = fieldset[secretFld];
  return challenge;
}

