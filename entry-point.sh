#!/bin/bash

# NODE_BINARY=node-v18.16.0-linux-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/');
# curl https://nodejs.org/dist/v18.16.0/$NODE_BINARY.tar.xz | tar Jxf -;
# ln -sf /$NODE_BINARY/bin/node /usr/local/bin/node;
# ln -sf /$NODE_BINARY/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm;
# ln -sf /$NODE_BINARY/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx;

[ -f /travis/travis.env ] && source /travis/travis.env || echo no travis.env to source with

ibmcloud login --apikey ${IBM_API_KEY:-apitoken} --no-region
ibmcloud version
ibmcloud plugin list

curl -o app.js https://raw.githubusercontent.com/xcliu-ca/cloud-usage-ibm/main/app.js
curl -o package.json https://raw.githubusercontent.com/xcliu-ca/cloud-usage-ibm/main/package.json

npm install
node app.js
