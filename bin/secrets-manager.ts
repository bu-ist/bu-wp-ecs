import { IContext, SecretFieldNames } from "../context/IContext";
import { SecretsManagerSecret } from "../lib/Secret";

/**
 * Script to create or update the secrets for this stack in AWS Secrets Manager.
 * The secret name and field names are based on values from the context file.
 * 
 * NOTE: Since this module is not being called as part of the CDK app, it is independent of it.
 * The goal here is to make secrets that survive stack deletion.
 */
export const createOrUpdateSecrets = async () => {
  // Parse command-line arguments: env=<name>, LANDSCAPE=<value>, SECRET_NAME=<value>
  const args = process.argv.slice(1);
  let envName = '';
  let landscapeOverride = '';
  let secretNameOverride = '';
  
  args.forEach((arg) => {
    const [key, value] = arg.split('=');
    const keyUpper = key.trim().toUpperCase();
    const keyLower = key.trim().toLowerCase();
    
    if (keyLower === 'env') {
      envName = value;
    } else if (keyUpper === 'LANDSCAPE') {
      landscapeOverride = value;
    } else if (keyUpper === 'SECRET_NAME') {
      secretNameOverride = value;
    }
  });
  
  // Load context file based on env=<name> argument, defaulting to context.json
  const contextFileName = envName ? `context-${envName}` : 'context';
  let contextJSON: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    contextJSON = require(`../context/${contextFileName}.json`);
  } catch (err) {
    console.error(`Failed to load context file: context/${contextFileName}.json`);
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
  const context = contextJSON as IContext;

  const { 
    STACK_ID, REGION, WORDPRESS: { 
      secret: { fieldNames: { configExtra, dbPassword } }, env: { dbUser } 
    } } = context;

  // Landscape can be overridden by LANDSCAPE= argument
  let { TAGS: { Landscape } } = context;
  if (landscapeOverride) {
    console.log(`Overriding Landscape tag from ${Landscape} from context to ${landscapeOverride} from argument`);
    Landscape = landscapeOverride;
  }
  if (secretNameOverride) {
    console.log(`Overriding entire secret name to ${secretNameOverride} from argument`);
  }

  const { WORDPRESS_CONFIG_EXTRA, DB_PASSWORD } = process.env;

  if( ! WORDPRESS_CONFIG_EXTRA ) {
    throw new Error('WORDPRESS_CONFIG_EXTRA environment variable must be set');
  }

  if( ! DB_PASSWORD ) {
    throw new Error('DB_PASSWORD environment variable must be set');
  }

  const secretName = secretNameOverride || `${STACK_ID}/${Landscape}`;
  const fldNames = { configExtra, dbPassword, spCert: 'N/A', spKey: 'N/A' } satisfies SecretFieldNames;
  const description = `Stores wordpress database username and password, and wp-config-extra, which contains sensitive values`;

  const smParms = { secretName, description, fldNames, region: REGION };
  console.log(`Preparing to create or update secret with parameters: ${JSON.stringify(smParms, null, 2)}`);
  const smSecret = new SecretsManagerSecret(smParms);

  smSecret
    .setValue(configExtra, WORDPRESS_CONFIG_EXTRA)
    .setValue(dbPassword, DB_PASSWORD)
    .setValue('username', dbUser || 'root');

  console.log(`Creating or updating secret: ${secretName}: ${await smSecret.getSecretValueJson() }`);

  await smSecret.save();
};