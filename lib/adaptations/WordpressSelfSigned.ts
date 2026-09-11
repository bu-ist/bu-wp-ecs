import { Stack } from "aws-cdk-lib";
import { WordpressEcsConstruct } from "../Wordpress";
import { ApplicationLoadBalancer, ApplicationProtocol, ListenerAction, TargetGroupLoadBalancingAlgorithmType } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { WordpressAppContainerDefConfig } from "../WordpressAppContainerDefConfig";


/**
 * There is no route53 hosted zone, so the alb for the fargate service construct must be created
 * BEFORE the https listener and target group are created for it. This is because the automatically
 * generated host name of the alb is needed by the wordpress container definition before it can be
 * created and configured for that target group.
 */
export class SelfSignedWordpressEcsConstruct extends WordpressEcsConstruct {

  constructor(baseline: Stack, id: string, props?: any) {
    super(baseline, id, props);
  }

  /**
   * Create the alb as public facing
   */
  adaptResourceProperties(): void {
    const { vpc, id, fargateServiceProps, context: { TAGS: { Landscape } } } = this;
    const alb = new ApplicationLoadBalancer(this, `${this.id}-alb`, {
      vpc, 
      internetFacing: true,
      loadBalancerName: `${id}-alb-${Landscape}`
    }); 

    Object.assign(fargateServiceProps, { 
      publicLoadBalancer: true,
      loadBalancerName: undefined,
      loadBalancer: alb,
   });
  }

  /**
   * Create an iam server certificate, https listener, and target group for secure traffic.
   */
  adaptResources(): void {
    const { id, containerDefProps: { containerName } } = this;
  
    // Create an https listener for the alb
    const listener443 = this.fargateService.loadBalancer.addListener(`${this.id}-https-listener`, {
      certificates: [ { certificateArn: this.props.iamServerCertArn } ],
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: `404 Error: ${this.context.TAGS.Landscape} Page not found`
      }),
      protocol: ApplicationProtocol.HTTPS,
    });

    // Associate the listener with a new target group for the wordpress container, and register the listener with the alb.
    // Note: ALB terminates TLS with self-signed cert; backend communication uses HTTP on port 80
    listener443.addTargets(`${this.id}-http-tg`, {
      protocol: ApplicationProtocol.HTTP,
      targetGroupName: `${this.id}-http-tg`,
      targets: [
        this.fargateService.service.loadBalancerTarget({
          containerName: containerName!,
          containerPort: WordpressAppContainerDefConfig.HOST_PORT,
        })
      ],
      healthCheck: {
        path: this.healthcheck,
        healthyThresholdCount: 3,
        healthyHttpCodes: '200-299',
      },
      loadBalancingAlgorithmType: TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
    });

    // ALTERNATIVE METHOD FOR HTTPS TARGET: 
    // this.fargateService.service.registerLoadBalancerTargets({
    //   containerName: `${this.containerDefProps.containerName}`,
    //   containerPort: WordpressAppContainerDefConfig.SSL_HOST_PORT,
    //   newTargetGroupId: `${this.id}-https-tg`,
    //   listener: ListenerConfig.applicationListener(listener443, {
    //     protocol: ApplicationProtocol.HTTPS,
    //     targetGroupName: `${this.id}-https-tg`,
    //     healthCheck: {
    //       enabled: true,
    //       healthyThresholdCount: 3,
    //       healthyHttpCodes: '200-499',
    //     },
    //     loadBalancingAlgorithmType: TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,          
    //   })
    // });   
  }
}