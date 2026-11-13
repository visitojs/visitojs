FROM mcr.microsoft.com/playwright:v1.63.0-noble
# the npm package must match the image version; /node_modules lets scripts under /work resolve it
WORKDIR /opt/lab
RUN npm init -y >/dev/null \
 && npm install --ignore-scripts --no-audit --no-fund playwright@1.63.0 \
 && ln -s /opt/lab/node_modules /node_modules
USER pwuser
WORKDIR /work
