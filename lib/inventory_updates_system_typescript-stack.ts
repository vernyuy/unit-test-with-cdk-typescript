import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import * as fs from "fs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as tags from "aws-cdk-lib/aws-resourcegroups";
import * as s3notification from "aws-cdk-lib/aws-s3-notifications";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";

export class InventoryUpdatesSystemTypescriptStack extends cdk.Stack {
  public readonly apiGatewayRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.apiGatewayRole = new iam.Role(this, "api-gateway-role", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    const role = new iam.Role(this, "LambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: "InventoryUpdatesTsLambdaRole",
      description: "Role for Lambda functions",
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["arn:aws:logs:*:*:*"],
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
      })
    );

    const dlq = new sqs.Queue(this, "InventoryUpdatesTsDlq", {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
    });
    cdk.Tags.of(dlq).add("InventoryUpdatesTs", "InventoryUpdatesTsDlq");

    const queue = new sqs.Queue(this, "InventoryUpdatesTsQueue", {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });
    cdk.Tags.of(queue).add("InventoryUpdatesTs", "InventoryUpdatesTsQueue");

    const policy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [dlq.queueArn],
      actions: ["sqs:SendMessage"],
      conditions: { ArnEquals: { "aws:SourceArn": queue.queueArn } },
    });
    // dlq policy
    new iam.PolicyDocument({
      statements: [policy],
    });

    const table = new dynamodb.Table(this, "InventoryUpdatesTsTable", {
      tableName: "InventoryUpdatesTsTable",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(table).add("InventoryUpdatesTs", "InventoryUpdatesTsTable");

    table.addGlobalSecondaryIndex({
      indexName: "productIndex",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    const bucket = new s3.Bucket(this, "InventoryUpdatesTsBucket", {
      versioned: true,
      bucketName: "InventoryUpdatesTsBucket",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(bucket).add("InventoryUpdatesTs", "InventoryUpdatesTsBucket");

    const inventoryUpdatesTsApi = new apigateway.RestApi(
      this,
      "InventoryUpdatesTsApi",
      {
        restApiName: "InventoryUpdatesTsApi",
        description: "Inventory Updates System API",
        defaultCorsPreflightOptions: {
          allowOrigins: apigateway.Cors.ALL_ORIGINS,
          allowMethods: apigateway.Cors.ALL_METHODS,
        },
        binaryMediaTypes: ['application/octet-stream', 'image/jpeg']
      }
    );
    cdk.Tags.of(inventoryUpdatesTsApi).add("InventoryUpdatesTs", "Api");

    const bucketRoute = inventoryUpdatesTsApi.root.addResource("{bucketName}");
    const itemRoute = bucketRoute.addResource("{itemName}");

    const bucketPolicy = {
      s3write: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [bucket.bucketArn],
            actions: ["s3:PutObject"],
          }),
        ],
      }),
    };

    const apiRole = new iam.Role(this, "ApiRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      roleName: "InventoryUpdatesTsApiRole",
      description: "Role for API Gateway",
      inlinePolicies: bucketPolicy,
    });
    this.addActionToPolicy("s3:ListBucket");
    const listBucketIntegration = new apigateway.AwsIntegration({
      service: "s3",
      region: "us-east-1",
      path: bucket.bucketName,
      integrationHttpMethod: "GET",
      options: {
        credentialsRole: this.apiGatewayRole,
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestParameters: {
          "integration.request.path.bucket": "method.request.path.folder",
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Content-Type":
                "integration.response.header.Content-Type",
            },
          },
        ],
      },
    });

    const listBucketMethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
      requestParameters: {
        "method.request.path.folder": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
          },
        },
      ],
    };
    bucketRoute.addMethod(
      "GET",
      listBucketIntegration,
      listBucketMethodOptions
    );

    //GetObject method
    this.addActionToPolicy("s3:GetObject");
    const getObjectIntegration = new apigateway.AwsIntegration({
      service: "s3",
      region: "us-east-1",
      path: bucket.bucketName + "/{object}",
      integrationHttpMethod: "GET",
      options: {
        credentialsRole: this.apiGatewayRole,
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestParameters: {
          "integration.request.path.bucket": "method.request.path.bucketName",
          "integration.request.path.object": "method.request.path.item",
          "integration.request.header.Accept": "method.request.header.Accept",
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Content-Type":
                "integration.response.header.Content-Type",
            },
          },
        ],
      },
    });

    //GetObject method options
    const getObjectMethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
      requestParameters: {
        "method.request.path.bucketName": true,
        "method.request.path.item": true,
        "method.request.header.Accept": true,
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
          },
        },
      ],
    };
    itemRoute.addMethod("GET", getObjectIntegration, getObjectMethodOptions);

    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "LambdaLayer",
      "arn:aws:lambda:eu-west-2:017000801446:layer:AWSLambdaPowertoolsPythonV2:58"
    );

    const csvProcessingToSqsFunction = new lambda.Function(
      this,
      "CsvProcessingToSqsFunction",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        code: lambda.Code.fromAsset("lambda/csvProcessingToSqs"),
        handler: "csvProcessingToSqs.handler",
        layers: [powertoolsLayer],
        tracing: lambda.Tracing.ACTIVE,
        role: role,
        memorySize: 512,
        environment: {
          QUEUE_URL: queue.queueUrl,
        },
      }
    );

    bucket.grantRead(csvProcessingToSqsFunction);

    const notification = new s3notification.LambdaDestination(
      csvProcessingToSqsFunction
    );
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, notification);
    //queue policy
    const topic = new sns.Topic(this, "InventoryUpdatesTsTopic");
    cdk.Tags.of(topic).add("InventoryUpdatesTs", "InventoryUpdatesTsTopic");

    const alarm = new cloudwatch.Alarm(this, "InventoryUpdatesTsAlarm", {
      metric: queue.metricApproximateNumberOfMessagesVisible(),
      threshold: 600,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(topic));
    cdk.Tags.of(alarm).add("InventoryUpdatesTs", "InventoryUpdatesTsAlarm");

    const queueLambdaPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [queue.queueArn],
      actions: ["sqs:SendMessage"],
      principals: [new iam.ArnPrincipal(role.roleArn)],
    });
    queue.addToResourcePolicy(queueLambdaPolicy);

    // Create an IAM policy statement allowing only HTTPS access to the queue
    new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ["sqs:*"],
      resources: [queue.queueArn],
      conditions: {
        Bool: {
          "aws:SecureTransport": "false",
        },
      },
    });

    const statemachineConsumeSqsMessage = new sfn.StateMachine(
      this,
      "StatemachineConsumeSqsMessage",
      {
        definitionBody: sfn.DefinitionBody.fromFile(""),
        stateMachineName: "InventoryUpdatesTsStateMachine",
        stateMachineType: sfn.StateMachineType.EXPRESS,
        logs: {
          level: sfn.LogLevel.ALL,
          destination: new logs.LogGroup(this, "InventoryUpdatesTsLogGroup"),
          includeExecutionData: true,
        },
      }
    );
    cdk.Tags.of(statemachineConsumeSqsMessage).add("InventoryUpdatesTs", "Statemachine");
    table.grantReadWriteData(statemachineConsumeSqsMessage);

    /// Pipe line source and target policy definitions
    const sourcePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [queue.queueArn],
      actions: ["sqs:SendMessage", "sqs:DeleteMessage"],
    });
    const targetPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [statemachineConsumeSqsMessage.stateMachineArn],
      actions: ["states:StartExecution"],
    });
    const pipeRole = new iam.Role(this, "PipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
      roleName: "InventoryUpdatesTsPipeRole",
      description: "Role for SQS to SNS Pipes",
    });

    pipeRole.addToPolicy(sourcePolicy);
    pipeRole.addToPolicy(targetPolicy);

    const cfnPipe = new pipes.CfnPipe(this, "Pipe", {
      roleArn: pipeRole.roleArn,
      source: queue.queueArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 10,
        },
      },
      target: statemachineConsumeSqsMessage.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: "FIRE_AND_FORGET",
        },
      },
    });
    cdk.Tags.of(cfnPipe).add("InventoryUpdatesTs", "Pipe");

    const crudStatemachine = new sfn.StateMachine(this, "CrudStatemachine", {
      definitionBody: sfn.DefinitionBody.fromFile(""),
      stateMachineName: "InventoryUpdatesTsCrudStateMachine",
      stateMachineType: sfn.StateMachineType.EXPRESS,
      logs: {
        level: sfn.LogLevel.ALL,
        destination: new logs.LogGroup(this, "InventoryUpdatesTsCrudLogGroup"),
        includeExecutionData: true,
      },
    });
    cdk.Tags.of(crudStatemachine).add("InventoryUpdatesTs", "Statemachine");
    table.grantReadWriteData(crudStatemachine);

    const products = inventoryUpdatesTsApi.root.addResource("products");
    const product = inventoryUpdatesTsApi.root.addResource("product");
    const productItem = product.addResource("{productId}");
    const warehouses = inventoryUpdatesTsApi.root.addResource("warehouses");
    const warehouse = inventoryUpdatesTsApi.root.addResource("warehouse");
    const warehouseItem = warehouse.addResource("{warehouseId}");

    products.addMethod(
      "GET",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );

    product.addMethod(
      "POST",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );

    productItem.addMethod(
      "GET",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );

    warehouses.addMethod(
      "GET",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );

    warehouse.addMethod(
      "POST",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );

    warehouseItem.addMethod(
      "GET",
      apigateway.StepFunctionsIntegration.startExecution(crudStatemachine, {
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestContext: {
          httpMethod: true,
          resourcePath: true,
        },
      })
    );
  }
  private addActionToPolicy(action: string) {
    this.apiGatewayRole.addToPolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: [`${action}`],
      })
    );
  }
}
