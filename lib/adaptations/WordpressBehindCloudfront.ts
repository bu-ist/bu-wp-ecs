import { DescribeManagedPrefixListsCommand, DescribeManagedPrefixListsRequest, DescribeManagedPrefixListsResult, EC2Client } from "@aws-sdk/client-ec2";
import { GetSecretValueCommand, GetSecretValueCommandOutput, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Stack } from "aws-cdk-lib";
import { Certificate, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { CfnSecurityGroup, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { ApplicationListener, ApplicationLoadBalancer, ApplicationLoadBalancerProps, CfnListener, ListenerAction, ListenerCondition } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ApplicationLoadBalancedFargateServiceProps, ApplicationLoadBalancedServiceRecordType } from "aws-cdk-lib/aws-ecs-patterns";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { Route53HostedZone } from '../../bin/Route53';
import { CloudfrontContext } from "../../context/IContext";
import { ParameterTester } from "../Utils";
import { WordpressEcsConstruct } from "../Wordpress";
import { WordpressAppContainerDefConfig } from "../WordpressAppContainerDefConfig";

/**
 * CloudFront-fronted WordPress deployment with Lambda@Edge SAML authentication.
 * A pre-existing CloudFront distribution is configured to point at the ALB created by this
 * stack as one of its origins. Optionally includes Route53 A record for custom domain.
 * Container does NOT redirect HTTP to HTTPS (CloudFront handles TLS termination).
 */
export class CloudfrontWordpressEcsConstruct extends WordpressEcsConstruct<CloudfrontContext> {

  alb: ApplicationLoadBalancer;
  
  constructor(baseline: Stack, id: string, props?: any) {
    super(baseline, id, props);
  }

  /**
   * Enforce singleton pattern for hosted zone construct to avoid name collisions.
   */
  private getDomainZone(): IHostedZone {
    const { context: { DNS: { hostedZone:domainName, crossAccountHostedZoneId } } } = this;

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
    
    // TYPE 'cloudfront' guarantees all three, but context.json is not type-checked at runtime.
    const { hostedZone, certificateARN:certArn, subdomain } = DNS;
    const { anyBlank } = ParameterTester;
    if (anyBlank(hostedZone, certArn, subdomain)) {
      throw new Error(
        'DNS.hostedZone, DNS.certificateARN and DNS.subdomain are all required when TYPE is "cloudfront"');
    }

    this.getDomainZone = this.getDomainZone.bind(this);
    const certificate = Certificate.fromCertificateArn(this, `${id}-acm-cert`, certArn) satisfies ICertificate;

    Object.assign(this.fargateServiceProps, {
      certificate,
      redirectHTTP: true,
      // This stack never creates the A record; the anchor CNAME is maintained in the zone's account.
      recordType: ApplicationLoadBalancedServiceRecordType.NONE,
      publicLoadBalancer: true,
      loadBalancer: this.alb,
      domainZone: this.getDomainZone(),
      domainName: subdomain,
    } as ApplicationLoadBalancedFargateServiceProps);
  }

  adaptResources(): void {
    const { loadBalancer: { listeners }, targetGroup } = this.fargateService
    const { isBlank, isNotBlank } = ParameterTester;
    const { challengeHeaderName } = this.context?.DNS?.cloudfront!;
    const challengeHeaderValue = this.props['cloudfront-challenge'];
    // Optional previous value, present only during a challenge-rotation window (dual-value "accept both,
    // then narrow"). Undefined outside a window, so the accepted set collapses to just the current value
    // and the synthesized rule is unchanged.
    const challengeHeaderValuePrevious = this.props['cloudfront-challenge-previous'];
    if(isBlank(challengeHeaderName)) {
      throw new Error('The alb challenge header name has not been set in context.json');
    }
    if(isBlank(challengeHeaderValue)) {
      throw new Error('The alb challenge header value was not provided (Did the lookup fail?)');
    }
    // Accept the current value plus, during a rotation window, the previous one. isNotBlank drops the
    // undefined/blank previous so a whitespace value can never become an accepted header on this boundary.
    const challengeHeaderValues = [ challengeHeaderValue, challengeHeaderValuePrevious ].filter(isNotBlank);

    // Find the https listener.
    const httpsListener = listeners.find((listener:ApplicationListener) => {
      return `${listener['protocol']}`.toLowerCase() == 'https';
    }) || {} as ApplicationListener;
    
    // Apply a rule to the listener making it only forward traffic if the expected cloudfront challenge
    // header is present and carries the current value (or, mid-rotation, the previous one).
    httpsListener.addAction(`${this.id}-listener-action`, {
      action: ListenerAction.forward([ targetGroup ]),
      conditions: [ ListenerCondition.httpHeader(challengeHeaderName, challengeHeaderValues) ],
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
    
    // ignoreRoute53 is true whenever no record was found, so this never fires for a new cluster;
    // the anchor CNAME is maintained in the hosted zone's own account.
    const { id, props: { ignoreRoute53 = false }, context: { DNS: {
      hostedZone, subdomain, cloudfront: { distributionDomainName = '' }
    } } } = this;

    if (ignoreRoute53) {
      console.log(`Ignoring route53 record creation for subdomain ${subdomain} in hosted zone ${hostedZone}`);
    }
    else {
      const route53HostedZone: Route53HostedZone = new Route53HostedZone(this.context);
      route53HostedZone.createARecord({
        scope: this,
        id: `${id}-cloudfront-alias-record`,
        distributionDomainName,
        hostedZone,
        recordName: subdomain
      });
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

