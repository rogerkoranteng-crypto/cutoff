// The installed aws CLI predates `--invoked-via-function-url`, so this adds that permission through the SDK.
import { LambdaClient, AddPermissionCommand } from '@aws-sdk/client-lambda';
const c = new LambdaClient({ region: 'us-east-1' });
try {
  await c.send(new AddPermissionCommand({ FunctionName: process.argv[2], StatementId: 'url-public-invoke', Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }));
  console.log('added');
} catch (e) { if (e.name === 'ResourceConflictException') console.log('already present'); else throw e; }
