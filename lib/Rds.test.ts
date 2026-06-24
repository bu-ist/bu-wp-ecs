import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { BuWordpressRdsConstruct } from './Rds';

/**
 * Proves the environmentType-derived RDS posture from synth output, without standing up
 * production-shaped resources. This is the first test in the repo; it carries its own setup —
 * a synthetic 'stack-parms' context, an in-test VPC, and an offline secret import (none of
 * which trigger CDK context lookups) — so the construct synthesizes entirely offline.
 *
 * The construct reads its context via scope.node.getContext('stack-parms') and takes the VPC
 * as a prop, exactly as bin/bu-wordpress-ecs.ts wires it.
 */

// A well-formed complete secret ARN (name + 6-char suffix). fromSecretCompleteArn is a static
// import, not a lookup, so this stays offline.
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:wp-test-AbCdEf';

const synthTemplate = (environmentType?: string): Template => {
  const app = new App();
  // Env-agnostic stack -> two dummy AZs, so the in-test VPC needs no availability-zones lookup.
  const stack = new Stack(app, 'TestStack');
  stack.node.setContext('stack-parms', {
    TAGS: { Landscape: 'test-landscape' },
    WORDPRESS: {
      secret: { wpSecretArn: SECRET_ARN },
      env: {
        dbType: 'serverless',
        dbName: 'wp_db',
        dbUser: 'root',
        environmentType,
      },
    },
  });
  const vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
  new BuWordpressRdsConstruct(stack, 'wp-rds', { vpc });
  return Template.fromStack(stack);
};

describe('BuWordpressRdsConstruct — correct by construction', () => {

  // Properties that hold regardless of environmentType.
  describe.each(['development', 'staging', 'production', undefined])(
    'invariants (environmentType=%s)', (environmentType) => {

      const template = synthTemplate(environmentType as string | undefined);

      it('is v2-native: one DBCluster, no v1 EngineMode escape hatch', () => {
        template.resourceCountIs('AWS::RDS::DBCluster', 1);
        template.hasResourceProperties('AWS::RDS::DBCluster', {
          Engine: 'aurora-mysql',
          EngineMode: Match.absent(),
        });
      });

      it('is encrypted at rest', () => {
        template.hasResourceProperties('AWS::RDS::DBCluster', { StorageEncrypted: true });
      });

      it('is on the current pinned engine, not the stale 3.04 pin', () => {
        template.hasResourceProperties('AWS::RDS::DBCluster', {
          EngineVersion: '8.0.mysql_aurora.3.12.0',
        });
      });

      it('is private: no instance is publicly accessible', () => {
        const instances = template.findResources('AWS::RDS::DBInstance');
        Object.values(instances).forEach((instance: any) => {
          expect(instance.Properties.PubliclyAccessible).not.toBe(true);
        });
      });

      it('caps scaling at ACU 8', () => {
        template.hasResourceProperties('AWS::RDS::DBCluster', {
          ServerlessV2ScalingConfiguration: Match.objectLike({ MaxCapacity: 8 }),
        });
      });
    });

  describe('non-production posture (environmentType=development)', () => {
    const template = synthTemplate('development');

    it('is DESTROY on teardown', () => {
      template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Delete' });
    });

    it('retains backups for 1 day', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { BackupRetentionPeriod: 1 });
    });

    it('has no API/console deletion protection', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: false });
    });

    it('is writer-only (no HA reader)', () => {
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
    });

    it('scales to zero (MinCapacity 0)', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0 }),
      });
    });
  });

  describe('staging posture (environmentType=staging) — durable but cost-optimized', () => {
    const template = synthTemplate('staging');

    it('is RETAIN on teardown', () => {
      template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Retain' });
    });

    it('retains backups for 7 days', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { BackupRetentionPeriod: 7 });
    });

    it('has no deletion protection and no HA reader, and still scales to zero', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: false });
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0 }),
      });
    });
  });

  describe('production posture (environmentType=production)', () => {
    const template = synthTemplate('production');

    it('is RETAIN on teardown', () => {
      template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Retain' });
    });

    it('retains backups for 7 days', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { BackupRetentionPeriod: 7 });
    });

    it('has API/console deletion protection', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: true });
    });

    it('has a writer + an HA reader', () => {
      template.resourceCountIs('AWS::RDS::DBInstance', 2);
    });

    it('keeps a non-zero scaling floor (MinCapacity 1) to avoid cold starts', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 1 }),
      });
    });
  });

  it('fails safe to the production posture on an unrecognized environmentType', () => {
    // Belt-and-suspenders: an omitted value must resolve to RETAIN + reader + non-zero floor,
    // never to a DESTROY-on-teardown database.
    const template = synthTemplate(undefined);
    template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
    template.resourceCountIs('AWS::RDS::DBInstance', 2);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 1 }),
    });
  });
});
