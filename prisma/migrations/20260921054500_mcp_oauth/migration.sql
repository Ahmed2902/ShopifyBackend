CREATE TABLE "McpOAuthClient" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpAuthorizationRequest" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "state" TEXT,
    "scopes" TEXT[] NOT NULL,
    "resource" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpAuthorizationCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "resource" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpRefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");
CREATE INDEX "McpAuthorizationRequest_expiresAt_idx" ON "McpAuthorizationRequest"("expiresAt");
CREATE UNIQUE INDEX "McpAuthorizationCode_codeHash_key" ON "McpAuthorizationCode"("codeHash");
CREATE INDEX "McpAuthorizationCode_expiresAt_idx" ON "McpAuthorizationCode"("expiresAt");
CREATE INDEX "McpAuthorizationCode_userId_storeId_createdAt_idx" ON "McpAuthorizationCode"("userId", "storeId", "createdAt");
CREATE UNIQUE INDEX "McpRefreshToken_tokenHash_key" ON "McpRefreshToken"("tokenHash");
CREATE INDEX "McpRefreshToken_userId_storeId_createdAt_idx" ON "McpRefreshToken"("userId", "storeId", "createdAt");
CREATE INDEX "McpRefreshToken_expiresAt_revokedAt_idx" ON "McpRefreshToken"("expiresAt", "revokedAt");
