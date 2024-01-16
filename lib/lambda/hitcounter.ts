import {APIGatewayEvent} from 'aws-lambda';
import {DynamoDB} from 'aws-sdk'
import {v4 as uuid} from 'uuid'



export const handler = async function(event:any) {
    console.log("request:", JSON.stringify(event, undefined, 2));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain" },
      body: `Hello, CDK! You've hit ${event.path}\n`
    };
  };