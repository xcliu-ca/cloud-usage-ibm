FROM redhat/ubi9

RUN dnf update; du -sh /usr /var /root; dnf install -y less unzip nodejs; du -sh /usr /var /root

ENV SLACK_TOKEN=
ENV SLACK_CHANNEL=#cs-public-cloud-usage
ENV SLACK_MENTION=allevas
ENV IBM_API_KEY=
ENV IBM_CLOUD_REGIONS=ca-tor,us-east,us-south,in-che

RUN curl -fsSL https://clis.cloud.ibm.com/install/linux | sh; sleep 20; ibmcloud plugin install ks is

WORKDIR /workdir
COPY Dockerfile .
COPY entry-point.sh .
COPY package.json .
COPY app.js .

ENTRYPOINT ["./entry-point.sh"]

