#!/usr/bin/env bash
# Reproducible deploy with the plain aws CLI. Idempotent: safe to re-run.
# Needs: aws CLI authenticated to account 854924711083, node 22+, zip, and ../../.env with the PayPal SANDBOX keys.
set -euo pipefail
cd "$(dirname "$0")"
REGION=us-east-1
ACCOUNT=854924711083
NAME=cutoff-triage
TABLE=$NAME
ROLE=$NAME-lambda
BUCKET=$NAME-site-$ACCOUNT
MODEL=${BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}
OUT=.aws-out; mkdir -p $OUT

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account"; exit 1; }
set -a; . ../../.env; set +a
: "${PAYPAL_CLIENT_ID:?}" "${PAYPAL_SECRET:?}"

echo "== DynamoDB (on-demand, TTL)"
if ! aws dynamodb describe-table --table-name $TABLE --region $REGION >/dev/null 2>&1; then
  aws dynamodb create-table --region $REGION --table-name $TABLE --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE --region $REGION
  aws dynamodb update-time-to-live --region $REGION --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null
fi

echo "== IAM role"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
fi
aws iam put-role-policy --role-name $ROLE --policy-name app --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Query\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"},
  {\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"arn:aws:lambda:$REGION:$ACCOUNT:function:$NAME\"},
  {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:Converse\"],\"Resource\":\"*\"}]}"
ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$ROLE

echo "== Lambda package (the AWS SDK v3 comes from the Node 22 runtime, so nothing is bundled)"
(cd backend && rm -f ../$OUT/fn.zip && zip -qr ../$OUT/fn.zip package.json src)
envjson() { WID="${1:-}" node -e "console.log(JSON.stringify({Variables:{PAYPAL_CLIENT_ID:process.env.PAYPAL_CLIENT_ID,PAYPAL_SECRET:process.env.PAYPAL_SECRET,PAYPAL_API:process.env.PAYPAL_API,PAYPAL_WEBHOOK_ID:process.env.WID,BEDROCK_MODEL:'$MODEL',TABLE_NAME:'$TABLE',BEDROCK_DAILY_CAP:'300',LIVE_DISPUTE_IDS:'${LIVE_DISPUTE_IDS:-PP-R-IQQ-10190238}'}}))"; }
WID_SAVED=$(cat $OUT/webhook_id 2>/dev/null || true)
ENVJSON=$(envjson "$WID_SAVED")
if ! aws lambda get-function --function-name $NAME --region $REGION >/dev/null 2>&1; then
  sleep 10  # IAM propagation
  aws lambda create-function --region $REGION --function-name $NAME --runtime nodejs22.x --handler src/handler.handler \
    --role $ROLE_ARN --zip-file fileb://$OUT/fn.zip --timeout 300 --memory-size 512 --environment "$ENVJSON" >/dev/null
else
  aws lambda update-function-code --region $REGION --function-name $NAME --zip-file fileb://$OUT/fn.zip >/dev/null
  aws lambda wait function-updated --region $REGION --function-name $NAME
  aws lambda update-function-configuration --region $REGION --function-name $NAME --timeout 300 --memory-size 512 --environment "$ENVJSON" >/dev/null
fi
aws lambda wait function-updated --region $REGION --function-name $NAME

echo "== Function URL"
if ! aws lambda get-function-url-config --function-name $NAME --region $REGION >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name $NAME --region $REGION --auth-type NONE >/dev/null
  aws lambda add-permission --function-name $NAME --region $REGION --statement-id url-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
fi
(cd backend && [ -d node_modules/@aws-sdk/client-lambda ] || npm install --no-audit --no-fund >/dev/null; node scripts/allow-url-invoke.mjs $NAME)
FURL=$(aws lambda get-function-url-config --function-name $NAME --region $REGION --query FunctionUrl --output text)
FHOST=$(echo "$FURL" | sed -E 's#https://([^/]+)/?#\1#')

echo "== PayPal webhook (sandbox)"
WID=$(cd backend && node scripts/ensure-webhook.mjs "$FURL")
echo "$WID" > $OUT/webhook_id
if [ "$WID" != "$WID_SAVED" ]; then
  ENVJSON=$(envjson "$WID")
  aws lambda update-function-configuration --region $REGION --function-name $NAME --environment "$ENVJSON" >/dev/null
  aws lambda wait function-updated --region $REGION --function-name $NAME
fi

echo "== S3 site bucket"
if ! aws s3api head-bucket --bucket $BUCKET 2>/dev/null; then
  aws s3api create-bucket --bucket $BUCKET --region $REGION >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

echo "== CloudFront (S3 for the site, the Function URL for /api/*)"
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [ "$DIST" = "None" ] || [ -z "$DIST" ]; then
  OAC=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='$NAME-oac'].Id | [0]" --output text)
  if [ "$OAC" = "None" ] || [ -z "$OAC" ]; then
    OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=$NAME-oac,Description=$NAME,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text)
  fi
  cat > $OUT/dist.json <<JSON
{"CallerReference":"$NAME-$(date +%s)","Comment":"$NAME","Enabled":true,"DefaultRootObject":"index.html","PriceClass":"PriceClass_100","HttpVersion":"http2and3",
 "Origins":{"Quantity":2,"Items":[
  {"Id":"s3","DomainName":"$BUCKET.s3.$REGION.amazonaws.com","OriginAccessControlId":"$OAC","S3OriginConfig":{"OriginAccessIdentity":""}},
  {"Id":"fn","DomainName":"$FHOST","CustomOriginConfig":{"HTTPPort":80,"HTTPSPort":443,"OriginProtocolPolicy":"https-only","OriginSslProtocols":{"Quantity":1,"Items":["TLSv1.2"]},"OriginReadTimeout":60,"OriginKeepaliveTimeout":5}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"s3","ViewerProtocolPolicy":"redirect-to-https","Compress":true,"AllowedMethods":{"Quantity":2,"Items":["GET","HEAD"]},"CachePolicyId":"658327ea-f89d-4fab-a63d-7e88639e58f6"},
 "CacheBehaviors":{"Quantity":1,"Items":[{"PathPattern":"/api/*","TargetOriginId":"fn","ViewerProtocolPolicy":"https-only","Compress":true,
   "AllowedMethods":{"Quantity":7,"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],"CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
   "CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","OriginRequestPolicyId":"b689b0a8-53d0-40ab-baf2-68738e2966ac"}]}}
JSON
  DIST=$(aws cloudfront create-distribution --distribution-config file://$OUT/dist.json --query Distribution.Id --output text)
fi
DIST_ARN=arn:aws:cloudfront::$ACCOUNT:distribution/$DIST
aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"cf\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"$DIST_ARN\"}}}]}"

echo "== Front end"
(cd web && { [ -d node_modules ] || { [ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund; }; } && npm run build)
aws s3 sync web/dist s3://$BUCKET --delete --cache-control 'no-cache' >/dev/null
aws s3 cp web/dist/index.html s3://$BUCKET/index.html --cache-control 'no-cache' --content-type 'text/html; charset=utf-8' >/dev/null
aws cloudfront create-invalidation --distribution-id $DIST --paths '/*' >/dev/null

CFDOM=$(aws cloudfront get-distribution --id $DIST --query Distribution.DomainName --output text)
cat > $OUT/urls.env <<URLS
FUNCTION_URL=$FURL
CLOUDFRONT_URL=https://$CFDOM
DISTRIBUTION_ID=$DIST
BUCKET=$BUCKET
WEBHOOK_ID=$WID
URLS
echo "Function URL : $FURL"; echo "CloudFront   : https://$CFDOM"; echo "Webhook id   : $WID"
