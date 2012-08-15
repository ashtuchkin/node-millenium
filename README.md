# Node.js test for 1M HTTP Comet connections

This is the server part of my test of 1M concurrent connections on Node.js server.
Client part is [ec2-fleet](https://github.com/ashtuchkin/ec2-fleet) and uses Amazon Web Services.

If you can read Russian, see habrahabr article for more details.

See some graphs below.

## How it looks like

<img src="http://habrastorage.org/storage2/9b1/772/d42/9b1772d4272f590fc657153a60a01f2a.png"/>

## Reproducing the test

**Prerequisites:**
 1. Dedicated server on your favorite hosting with >=16Gb RAM and >=8 cores, external IP.
 2. AWS account with 1 dollar. We will use 40 micro instances ($0.02/hr) for 1 hour.

**Steps:**
 1. Dedicated server.
   1. Install fresh Ubuntu 12.04.
   1. Increase limit on open file descriptors: write ```* - nofile 1048576``` to ```/etc/security/limits.conf```. Reboot.
   1. ```git clone git://github.com/ashtuchkin/node-millenium.git``` and run ```node server.js```. Leave this terminal open.
 1. AWS instances as clients.
   1. Open EC2 control panel of your AWS account https://console.aws.amazon.com/ec2/home
   1. Choose 3 regions where you will launch client instances in. In each of them, go to Security Groups, 
      choose 'default', go to tab 'Inbound' at the bottom, add custom TCP rule: port 8889, source 0.0.0.0/0. 
      Dont forget to 'Apply Rule Changes'.
   1. On your laptop, ```git clone git://github.com/ashtuchkin/ec2-fleet.git```. Edit file aws-config.json to add your [AWS security keys](https://portal.aws.amazon.com/gp/aws/securityCredentials) and regions you've chosen.
 1. Start test.
   1. In separate terminal, issue ```./aws.js status```. This will give you an overview of all instances in all regions. Leave this open too.
   1. Start 40 instances in AWS: ```./aws.js start 40```. Wait ~2 minutes while they are starting.
   1. Target them to your server: ```./aws.js set ip <ip of your server>```.
   1. Gradually increase (in steps of ~2500-5000) the number of connections each instance makes to the server ```./aws.js set n <number of connections>``` until you reach maximum of ```25000``` connections.
   1. Go have a beer. You have a server with 1 million connections (40*25k).
   1. Gradually decrease the number of connections (same steps).
   1. Terminate all aws instances that we started (if you had other instances running, they are not touched): ```./aws.js stop all```
   1. Get log from server to make pretty graphs.

## Test: node server.js

Dotted line - connection count, with maximum at 1 million.

<img src="http://s3-eu-west-1.amazonaws.com/habr1/log1mem-eng.png"/>
<img src="http://s3-eu-west-1.amazonaws.com/habr1/log1cpu-eng1.png"/>

## Test: node --nouse-idle-notification server.js
<img src="http://s3-eu-west-1.amazonaws.com/habr1/log4mem-eng.png"/>
<img src="http://s3-eu-west-1.amazonaws.com/habr1/log4cpu-eng.png"/>



## License: MIT