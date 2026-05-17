import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { IContext } from '../context/IContext';
import { AdaptableConstruct } from './AdaptableFargateService';
import { WordpressS3ProxyContainerDefConfig } from './WordpressS3ProxyContainerDefConfig';

export class WordpressAppContainerDefConfig {

  public static HOST_PORT: number = 80;
  public static SSL_HOST_PORT: number = 443;

  public static DEFAULT_DB_USER:string = 'root';
  public static DEFAULT_DB_NAME:string = 'wp_db';
  public static DEFAULT_DB_HOST:string = 'db';

  public getProperties(scope: AdaptableConstruct) : ecs.ContainerDefinitionOptions {

    const { context, props } = scope;
    const { WORDPRESS:wp } = context as IContext;
    const { HOST_PORT:hostPort, SSL_HOST_PORT:sslHostPort, DEFAULT_DB_HOST, DEFAULT_DB_NAME, DEFAULT_DB_USER } = WordpressAppContainerDefConfig;
    const { HOST_PORT:s3ProxyHostPort } = WordpressS3ProxyContainerDefConfig;

    const getRdsHost = () => {
      if(props?.rdsHostName) {
        return props?.rdsHostName;
      }
      if(wp.env?.dbHost) {
        return wp.env?.dbHost;
      }
      return DEFAULT_DB_HOST;
    }

    // Container serves HTTP on port 80 only. TLS termination happens upstream at the ALB.
    // NOTE: The host port must be left out or must be the same as the container port for AwsVpc or Host network mode.
    const portMappings = [{
      containerPort: hostPort,
      hostPort,
      protocol: ecs.Protocol.TCP
    }] as ecs.PortMapping[];

    // Define the container environment variables
    const { 
      TZ='America/New_York', 
      spEntityId:SP_ENTITY_ID='', 
      idpEntityId:IDP_ENTITY_ID='', 
      s3ProxyHost:S3PROXY_HOST=`http://localhost:${s3ProxyHostPort}`, 
      dbUser:WORDPRESS_DB_USER=DEFAULT_DB_USER,
      dbName:WORDPRESS_DB_NAME=DEFAULT_DB_NAME, 
      dbHost:WORDPRESS_DB_HOST=getRdsHost(),
      debug='0', // Default to debug off
      environmentType:WP_ENVIRONMENT_TYPE='production',
    } = wp.env;
    const WORDPRESS_DEBUG = `${debug}`;
    const WP_CLI_ALLOW_ROOT = 'true';

    // Define the container secrets
    const {
      spSecretArn, wpSecretArn, fieldNames: { configExtra, dbPassword, spCert, spKey }
    } = wp.secret;

    // Build secrets object conditionally based on deployment pattern
    const secrets: Record<string, ecs.Secret> = {
      WORDPRESS_CONFIG_EXTRA: ecs.Secret.fromSecretsManager(
        Secret.fromSecretCompleteArn(scope, configExtra, wpSecretArn), configExtra),
      WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(
        Secret.fromSecretCompleteArn(scope, dbPassword, wpSecretArn), dbPassword),
    };

    // Only mount SP secrets for ALB-direct pattern (container mod_shib)
    // Pattern: certificateARN present (not self-signed) BUT no CloudFront (Lambda@Edge would handle auth)
    // CloudFront-fronted patterns use Lambda@Edge for SAML; self-signed has no auth
    const requiresContainerModShib = context.DNS?.certificateARN && !context.DNS?.cloudfront;
    
    if (requiresContainerModShib) {
      secrets.SHIB_SP_KEY = ecs.Secret.fromSecretsManager(
        Secret.fromSecretCompleteArn(scope, spKey, spSecretArn), spKey);
      secrets.SHIB_SP_CERT = ecs.Secret.fromSecretsManager(
        Secret.fromSecretCompleteArn(scope, spCert, spSecretArn), spCert);
    }
    
    return {
      image: ecs.ContainerImage.fromRegistry(wp.dockerImage),
      containerName: 'wordpress',
      memoryReservationMiB: 1024,
      healthCheck: {
        command: [ 'CMD-SHELL', 'echo hello' ],
        interval: Duration.seconds(10),
        startPeriod: Duration.seconds(5),
        retries: 3
      },
      portMappings,
      logging: ecs.LogDriver.awsLogs({ 
        logGroup: new LogGroup(scope, `${scope.id}-logs`, {
          removalPolicy: RemovalPolicy.DESTROY,
          retention: RetentionDays.ONE_MONTH
        }),
        streamPrefix: scope.id,
      }),
      environment: { 
        SP_ENTITY_ID, IDP_ENTITY_ID, TZ, S3PROXY_HOST, WORDPRESS_DB_HOST,
        WORDPRESS_DB_USER, WORDPRESS_DB_NAME, WORDPRESS_DEBUG, WP_CLI_ALLOW_ROOT,
        WP_ENVIRONMENT_TYPE
      },
      secrets
    } as ecs.ContainerDefinitionOptions
  }
}