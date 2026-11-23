import { Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  CloudWatchDimensionSource, ConfigurationSet, EmailSendingEvent, EventDestination, SuppressionReasons
} from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import { Mail } from '../context/IContext';
import { WordpressEcsConstruct } from './Wordpress';

export interface MailProps {
  wordpress: WordpressEcsConstruct;
  mail: Mail;
}

/**
 * Lets WordPress send mail through Amazon SES as bu.edu, using the task role.
 *
 * Builds a configuration set of the cluster's own, grants the task role permission to send through it,
 * and tells the WordPress container (bu-core's ses-mail) to use it through plain environment variables.
 * Mail goes through SES in the stack's own region, where the configuration set lives.
 * The job runner runs the same task definition, so it can send too.
 */
export class MailConstruct extends Construct {

  public static SENDING_DOMAIN: string = 'bu.edu';

  constructor(scope: Construct, id: string, props: MailProps) {
    super(scope, id);

    const { SENDING_DOMAIN } = MailConstruct;
    const { wordpress, mail: { redirectTo } } = props;
    const { taskDefinition } = wordpress.fargateService;

    // Suppression and event publishing are set on this configuration set.
    const configurationSet = new ConfigurationSet(this, 'configuration-set', {
      configurationSetName: id,
      suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    configurationSet.addEventDestination('cloudwatch', {
      destination: EventDestination.cloudWatchDimensions([ {
        name: 'ses:configuration-set',
        source: CloudWatchDimensionSource.MESSAGE_TAG,
        defaultValue: id,
      } ]),
      events: [ EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT ],
    });

    const stack = Stack.of(this);
    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [ 'ses:SendEmail', 'ses:SendRawEmail' ],
      resources: [
        stack.formatArn({ service: 'ses', resource: 'identity', resourceName: SENDING_DOMAIN }),
        stack.formatArn({
          service: 'ses', resource: 'configuration-set', resourceName: configurationSet.configurationSetName
        }),
      ],
      conditions: { StringLike: { 'ses:FromAddress': `*@${SENDING_DOMAIN}` } },
    }));

    // The set's name is a reference, so CloudFormation creates the set before the task definition naming it.
    const container = taskDefinition.defaultContainer!;
    container.addEnvironment('BU_MAIL_TRANSPORT', 'ses');
    container.addEnvironment('BU_SES_REGION', stack.region);
    container.addEnvironment('BU_SES_CONFIGURATION_SET', configurationSet.configurationSetName);
    if(redirectTo) {
      container.addEnvironment('BU_MAIL_REDIRECT_TO', redirectTo);
    }
  }
}
