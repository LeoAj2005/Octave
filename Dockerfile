# Use Node.js 20 LTS (Iron) - Active LTS until April 2026
FROM node:20-slim

# Install bash, build tools, and jq (for JSON parsing)
RUN apt-get update && apt-get install -y bash build-essential jq

# Install the official webOS CLI tools globally
RUN npm install -g @webosose/ares-cli

# Set working directory inside the container
WORKDIR /app

# Copy package scripts if needed (optional)
COPY package*.json ./

# Install project dependencies if you have them
RUN if [ -f package.json ]; then npm install; fi

# Default command to run your new, dynamic packaging script
CMD ["/bin/bash", "./package.sh"]