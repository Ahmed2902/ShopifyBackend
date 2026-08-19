declare module 'express-serve-static-core' {
  interface Request {
    context: {
      userId?: string;
      storeId?: string;
      role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    };
  }
}

export {};
