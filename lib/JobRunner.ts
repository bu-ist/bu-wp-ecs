import { Duration, TimeZone } from 'aws-cdk-lib';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Schedule, ScheduleExpression, ScheduleTargetInput } from 'aws-cdk-lib/aws-scheduler';
import { EcsRunFargateTask } from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { JobRunner } from '../context/IContext';
import { WordpressEcsConstruct } from './Wordpress';

export interface JobRunnerProps {
  wordpress: WordpressEcsConstruct;
  jobRunner: JobRunner;
}

/**
 * Runs the site-manager job queue on a schedule as an ephemeral Fargate task.
 *
 * The task is a run of the WordPress service's own task definition with its command overridden; 
 * so it inherits the image, both IAM roles, and the security group the service already uses.
 * The primary consumer of this task is the site-manager job queue, which it processes on a schedule.
 */
export class JobRunnerConstruct extends Construct {

  constructor(scope: Construct, id: string, props: JobRunnerProps) {
    super(scope, id);

    const { wordpress, jobRunner: { schedule, timeZone, enabled = true } } = props;
    const { cluster, taskDefinition } = wordpress.fargateService;

    // The override names the task definition's primary container, which is the WordPress one —
    // WordpressAppContainerDefConfig adds it first and marks it essential.
    const containerName = taskDefinition.defaultContainer!.containerName;

    new Schedule(this, 'schedule', {
      scheduleName: id,
      description: 'Drains the site-manager job queue on an ephemeral WordPress task.',
      schedule: ScheduleExpression.expression(
        schedule, timeZone ? TimeZone.of(timeZone) : undefined
      ),
      enabled,
      target: new EcsRunFargateTask(cluster, {
        taskDefinition,
        // Private subnets with NAT egress: the task reaches Secrets Manager and ECR the same way
        // the long-running service does, so it needs no public address.
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        assignPublicIp: false,
        securityGroups: [ wordpress.securityGroup ],
        enableEcsManagedTags: true,
        maxEventAge: Duration.hours(24),
        input: ScheduleTargetInput.fromObject({
          containerOverrides: [ {
            name: containerName,
            command: [ 'wp', 'site-manager', 'process-jobs', '--stay-open' ],
            environment: [ { name: 'JOB_PROCESSOR_MODE', value: 'true' } ],
          } ],
        }),
      }),
    });
  }
}
