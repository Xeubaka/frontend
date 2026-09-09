FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY . .
EXPOSE 8081
CMD ["serve", "-s", ".", "-l", "8081"]
