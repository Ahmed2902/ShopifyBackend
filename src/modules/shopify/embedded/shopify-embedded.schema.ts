import { z } from 'zod';

export const shopifyOnlineAccessTokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
  expires_in: z.number().int().positive(),
  associated_user_scope: z.string().default(''),
  associated_user: z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
    account_owner: z.boolean(),
    collaborator: z.boolean().default(false),
    email_verified: z.boolean().default(false),
    email: z.string().email(),
    first_name: z.string().default(''),
    last_name: z.string().default(''),
    locale: z.string().default('en'),
  }),
});

export type ShopifyOnlineAccessTokenResponse = z.infer<typeof shopifyOnlineAccessTokenSchema>;
export type ShopifyAssociatedUser = ShopifyOnlineAccessTokenResponse['associated_user'];
