import { Stack } from "aws-cdk-lib";
import { Certificate, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { ApplicationLoadBalancedServiceRecordType } from "aws-cdk-lib/aws-ecs-patterns";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { WordpressEcsConstruct } from "../Wordpress";


/**
 * Container mod_shib SAML authentication pattern (no CloudFront).
 * ALB is exposed directly via Route53 with an ACM certificate. Container runs mod_shib
 * for SAML authentication. Route53 is required (not optional) for stable SAML entity IDs
 * and callback URLs.
 * 
 * This pattern exists solely as an escape hatch while CloudFront Lambda@Edge SAML (the
 * preferred production pattern) is being proven in production. Once Lambda@Edge SAML is
 * stable, this adaptation should be removed entirely (YAGNI - no other use case exists).
 */
export class ContainerModShibWordpressEcsConstruct extends WordpressEcsConstruct {

  adaptResourceProperties(): void {

    // Unpack needed values
    const { id, context: { DNS: { certificateARN:certArn = '', hostedZone:domainName = '' } = {} } } = this;

    // Look up the hosted zone and certificate
    const domainZone = HostedZone.fromLookup(this, 'Zone', { domainName }) satisfies IHostedZone;
    const certificate = Certificate.fromCertificateArn(this, `${id}-acm-cert`, certArn) satisfies ICertificate;

    Object.assign(this.fargateServiceProps, { 
      certificate, 
      domainName, 
      domainZone,
      // TODO: Not sure if redirectHTTP will negate health checks that are made over http (not https).
      // However, as long as the shibboleth.conf file for apache exempts the health check path, health checks over https should be ok.
      redirectHTTP: true,
      recordType: ApplicationLoadBalancedServiceRecordType.ALIAS
    });

  }

  adaptResources(): void { /** Do nothing */ }
}