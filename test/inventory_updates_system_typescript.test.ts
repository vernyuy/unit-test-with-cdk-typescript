import { Template, Capture } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { HitCounter } from '../lib/hitcounter';


test('DynamoDB Table Created', () => {
  const stack = new cdk.Stack();
  // WHEN
  new HitCounter(stack, 'MyTestConstruct', {
    downstream:  new lambda.Function(stack, 'TestFunction', {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'hitcounter.handler',
      code: lambda.Code.fromAsset('lib/lambda')
    }),
    readCapacity: 10,
  });
  // THEN

  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::DynamoDB::Table", 1);
});


test('Lambda Has Environment Variables', () => {
    const stack = new cdk.Stack();
    // WHEN
    new HitCounter(stack, 'MyTestConstruct', {
      downstream:  new lambda.Function(stack, 'TestFunction', {
        runtime: lambda.Runtime.NODEJS_14_X,
        handler: 'hello.handler',
        code: lambda.Code.fromAsset('lib/lambda')
      }),
      readCapacity: 5
    });
    // THEN
    const template = Template.fromStack(stack);
    const envCapture = new Capture();
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: envCapture,
    });
  
    expect(envCapture.asObject()).toEqual(
      {
        Variables: {
          DOWNSTREAM_FUNCTION_NAME: {
            Ref: "TestFunction22AD90FC",
          },
          HITS_TABLE_NAME: {
            Ref: "MyTestConstructHits24A357F0",
          },
        },
      }
    );
  });


  test('DynamoDB Table Created With Encryption', () => {
    const stack = new cdk.Stack();
    // WHEN
    new HitCounter(stack, 'MyTestConstruct', {
      downstream:  new lambda.Function(stack, 'TestFunction', {
        runtime: lambda.Runtime.NODEJS_14_X,
        handler: 'hello.handler',
        code: lambda.Code.fromAsset('lib/lambda')
      }),
      readCapacity: 2
    });
    // THEN
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: {
        SSEEnabled: true
      }
    });
  });


  test('read capacity can be configured', () => {
    const stack = new cdk.Stack();
  
    expect(() => {
      new HitCounter(stack, 'MyTestConstruct', {
        downstream:  new lambda.Function(stack, 'TestFunction', {
          runtime: lambda.Runtime.NODEJS_14_X,
          handler: 'hello.handler',
          code: lambda.Code.fromAsset('lib/lambda')
        }),
        readCapacity: 2
      });
    }).toThrow(/readCapacity must be greater than 5 and less than 20/);
  });