import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Peer, Port, SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import { AuroraCapacityUnit, AuroraMysqlEngineVersion, ClusterInstance, Credentials, DatabaseCluster, DatabaseClusterEngine, } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { IContext, WORDPRESS_DB_TYPE } from '../context/IContext';

/**
 * The environment type as expressed by WordPress (WP_ENVIRONMENT_TYPE), per
 * wp_get_environment_type(). We use it here to determine the RDS posture on durability, availability, and scaling.
 * For background on available values see: https://developer.wordpress.org/reference/functions/wp_get_environment_type/
 */
type WordpressEnvironmentType = 'local' | 'development' | 'staging' | 'production';

/**
 * RDS posture is derived from the one environmentType input.
 * This groups teardown policy, backup retention, deletion protection, reader presence, and serverless capacity bounds in one shape.
 * Keeping these together prevents drift from independently tuned flags.
 */
interface RdsPosture {
  /** CloudFormation-path teardown guard. */
  removalPolicy: RemovalPolicy;
  /** Automated backup retention, in days. */
  backupRetentionDays: number;
  /** API/console-path deletion guard (belt to removalPolicy's suspenders). */
  deletionProtection: boolean;
  /** Whether a second-AZ serverless v2 reader is provisioned (high availability only; stock WordPress cannot read-scale). */
  includeReader: boolean;
  /** Serverless v2 minimum capacity, in ACU. 0 enables auto-pause / scale-to-zero. */
  minCapacity: number;
  /** Serverless v2 maximum capacity, in ACU. */
  maxCapacity: number;
}

export class BuWordpressRdsConstruct extends Construct {

  private context: IContext;
  private rdsSocketAddress: string;
  private securityGroup: SecurityGroup;
  private port: number;
  private props: any;
  private id: string;

  public static DEFAULT_DB_TYPE:WORDPRESS_DB_TYPE = WORDPRESS_DB_TYPE.SERVERLESS;
  public static DEFAULT_PORT:string = '3306';

  /**
   * The Aurora MySQL 3.x version the cluster is born on. Pinned to the latest available
   * (re-verify at deploy time) via AuroraMysqlEngineVersion.of(...) because the installed
   * aws-cdk-lib 2.222 only exposes named constants through VER_3_10_1. Auto-minor-version
   * upgrade is left on, so this is a forward-drifting birth floor.
   */
  public static ENGINE_FULL_VERSION:string = '8.0.mysql_aurora.3.12.0';
  public static ENGINE_MAJOR_VERSION:string = '8.0';

  constructor(scope: Construct, id: string, props?: any) {

    super(scope, id);

    this.context = scope.node.getContext('stack-parms');
    this.props = props;
    this.id = id;

    this.build();
  }

  /**
  * Maps WP_ENVIRONMENT_TYPE to an RDS posture.
  *
  * Intent:
  * - Production defaults prioritize durability and high availability.
  * - Staging keeps retention but relaxes cost/high availability settings.
  * - Development/local optimize for low cost and easy teardown.
  * - Unknown or missing values default to production posture.
  */
  private static derivePosture = (environmentType?: WordpressEnvironmentType): RdsPosture => {
    const PRODUCTION: RdsPosture = {
      removalPolicy: RemovalPolicy.RETAIN,
      backupRetentionDays: 7,
      deletionProtection: true,
      includeReader: true, // Only for high availability; WordPress won't use it for read scaling, but it helps for AZ failover.
      minCapacity: AuroraCapacityUnit.ACU_1,
      maxCapacity: AuroraCapacityUnit.ACU_8,
    };
    switch(environmentType) {
      case 'development':
      case 'local':
        return {
          removalPolicy: RemovalPolicy.DESTROY,
          backupRetentionDays: 1,
          deletionProtection: false,
          includeReader: false,  // No high availability for dev/local.
          minCapacity: 0,
          maxCapacity: AuroraCapacityUnit.ACU_8,
        };
      case 'staging':
        return {
          removalPolicy: RemovalPolicy.RETAIN,
          backupRetentionDays: 7,
          deletionProtection: false,
          includeReader: false,  // No high availability for staging.
          minCapacity: 0,
          maxCapacity: AuroraCapacityUnit.ACU_8,
        };
      case 'production':
        return PRODUCTION;
      default:
        // Unknown or missing environmentType defaults to the production-safe posture.
        return PRODUCTION;
    }
  }

  private build = () => {
    const { DEFAULT_DB_TYPE, DEFAULT_PORT, ENGINE_FULL_VERSION, ENGINE_MAJOR_VERSION } = BuWordpressRdsConstruct;
    const { id, context: { TAGS: { Landscape }, WORDPRESS: { secret: { wpSecretArn }, env: {
      dbType = DEFAULT_DB_TYPE, dbName, dbUser, dbPort = DEFAULT_PORT, environmentType
    } } } } = this;
    const { vpc } = this.props;

    /**
     * NOTE: The following will automatically be added to the secret along with the username
     * and password: dbClusterIdentifier, engine, host, port, and dbname.
     * CDK documenation states it will "create" a new secret, but they leave out that it will
     * actually "patch" an existing secret if one is already there of the same name, instead 
     * of "paving over" it.
     */
    const credentials: Credentials = Credentials.fromSecret(
      Secret.fromSecretCompleteArn(this, `${id}-secret`, wpSecretArn), dbUser
    );

    this.port = Number.parseInt(dbPort);

    this.securityGroup = new SecurityGroup(this, `${id}-mysql-sg`, {
      vpc, 
      securityGroupName: `wp-rds-mysql-${Landscape}-sg`,
      description: 'Allows for ingress to the wordpress rds db only from ecs tasks.',
      allowAllOutbound: true,
    });

    // Durability, high availability, and scaling all derive from the single environmentType signal.
    const posture = BuWordpressRdsConstruct.derivePosture(environmentType);
    const scaleToZero = posture.minCapacity === 0;

    // Keep the dbType switch for context compatibility and future expansion.
    // Right now, we are only using one option: Aurora Serverless v2 implementation, so deployments share a single secure baseline.
    // Legacy instance and v1 serverless branches were removed.
    switch(dbType) {

      case WORDPRESS_DB_TYPE.SERVERLESS:
      default:
        const readers = posture.includeReader ? [
          ClusterInstance.serverlessV2(`${id}-mysql-reader`, {
            publiclyAccessible: false,
            autoMinorVersionUpgrade: true,
            scaleWithWriter: true,
            instanceIdentifier: `${id}-mysql-reader-instance`,
          })
        ] : undefined;

        const dc: DatabaseCluster = new DatabaseCluster(this, `${id}-mysql-cluster`, {
          vpc,
          // Private by default: PRIVATE_WITH_EGRESS is the only private group this VPC exposes
          // (no isolated group exists). The DB lands in subnets carrying a NAT route it never uses.
          vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
          engine: DatabaseClusterEngine.auroraMysql({
            version: AuroraMysqlEngineVersion.of(ENGINE_FULL_VERSION, ENGINE_MAJOR_VERSION),
          }),
          writer: ClusterInstance.serverlessV2(`${id}-mysql-writer`, {
            publiclyAccessible: false,
            autoMinorVersionUpgrade: true,
            instanceIdentifier: `${id}-mysql-writer-instance`,
          }),
          readers,
          serverlessV2MinCapacity: posture.minCapacity,
          serverlessV2MaxCapacity: posture.maxCapacity,
          // Auto-pause only applies when the floor is 0 ACU; set it explicitly so the synth is
          // assertable and idle non-production compute trends toward $0.
          ...(scaleToZero ? { serverlessV2AutoPauseDuration: Duration.minutes(5) } : {}),
          // Encrypted at rest as a first principle (AWS-managed aws/rds key). Immutable after creation.
          storageEncrypted: true,
          backup: { retention: Duration.days(posture.backupRetentionDays) },
          deletionProtection: posture.deletionProtection,
          copyTagsToSnapshot: true,
          defaultDatabaseName: dbName,
          credentials,
          securityGroups: [ this.securityGroup ],
          removalPolicy: posture.removalPolicy,
        });
        this.rdsSocketAddress = dc.clusterEndpoint.socketAddress;
        break;
    }
  }

  /**
   * Get the endpoint address for use in establishing database connections.
   */
  public get endpointAddress(): string {
    return this.rdsSocketAddress;
  }

  /**
   * Add an ingress rule to the rds security group to allow ingress from other resources/cidrs.
   * @param sg The security group whose members are being granted ingress through the rds instance/service security group.
   */
  public addSecurityGroupIngressTo(securityGroupId: string): void {
    const { securityGroup, port } = this;
    securityGroup.addIngressRule(Peer.securityGroupId(securityGroupId), Port.tcp(port));
  }
}
