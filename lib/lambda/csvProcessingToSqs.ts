// Create a lambda handler for hello world

// Import api gateway
import {APIGatewayProxyHandler} from 'aws-lambda';

// create a lambda handler

const handler: any = async (event: any) => {
    return {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Hello World',
        }),
    };
}