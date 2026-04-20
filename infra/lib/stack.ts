import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import * as fs from 'fs'
import * as path from 'path'

export class ResumeTailorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const TOKEN_SECRET_PARAM_NAME = '/personal-website/token-secret'

    // ── SSM parameter for the Anthropic API key ────────────────────────────
    const apiKeyParam = new ssm.StringParameter(this, 'AnthropicApiKey', {
      parameterName: '/resume-tailor/anthropic-api-key',
      stringValue: 'PLACEHOLDER',
      description: 'Anthropic API key for Claude',
      tier: ssm.ParameterTier.STANDARD,
    })

    // ── Lambda function ────────────────────────────────────────────────────
    const lambdaDir = path.join(__dirname, '../../lambda')
    const fn = new lambda.Function(this, 'TailorFunction', {
      functionName: 'resume-tailor-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'bundle.handler',
      code: lambda.Code.fromAsset(lambdaDir, {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            ['npm ci', 'npm run build', 'npm run bundle', 'cp bundle.js /asset-output/'].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string) {
              const { execSync } = require('child_process')
              const bundlePath = path.join(lambdaDir, 'bundle.js')
              if (!fs.existsSync(bundlePath)) {
                execSync('npm ci', { cwd: lambdaDir, stdio: 'inherit' })
                execSync('npm run build', { cwd: lambdaDir, stdio: 'inherit' })
                execSync('npm run bundle', { cwd: lambdaDir, stdio: 'inherit' })
              }
              execSync(`cp ${lambdaDir}/bundle.js ${outputDir}/`)
              return true
            },
          },
        },
      }),
      // Claude Opus 4.7 responses for resume tailoring can take 20-40s
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      environment: {
        ANTHROPIC_API_KEY_PARAM: apiKeyParam.parameterName,
        TOKEN_SECRET_PARAM: TOKEN_SECRET_PARAM_NAME,
        ALLOWED_ORIGIN: 'https://magalygutierrez.com',
      },
    })

    apiKeyParam.grantRead(fn)
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/personal-website/token-secret`],
    }))

    // ── Lambda Function URL ────────────────────────────────────────────────
    // No cors config here — the Lambda handles CORS inline (including OPTIONS preflight)
    // to avoid duplicate Access-Control-Allow-Origin headers
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── GitHub Actions OIDC deploy role ────────────────────────────────────
    const githubOrg = 'magalyg'
    const githubRepo = 'resume-tailor-api'

    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOIDC',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`
    )

    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'resume-tailor-github-deploy',
      assumedBy: new iam.WebIdentityPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${githubOrg}/${githubRepo}:ref:refs/heads/main`,
          },
        }
      ),
    })

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:GetFunction',
        ],
        resources: [fn.functionArn],
      })
    )

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-hnb659fds-*-role-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
        ],
      })
    )

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/cdk-bootstrap/hnb659fds/version`,
        ],
      })
    )

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Set as VITE_TAILOR_API_URL in the personal website GitHub secrets',
    })

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: fn.functionArn,
      description: 'Set as LAMBDA_FUNCTION_ARN in resume-tailor-api GitHub secrets',
    })

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set as AWS_DEPLOY_ROLE_ARN in resume-tailor-api GitHub secrets',
    })

    new cdk.CfnOutput(this, 'ApiKeyParamName', {
      value: apiKeyParam.parameterName,
      description: 'SSM parameter to populate with your Anthropic API key',
    })
  }
}
