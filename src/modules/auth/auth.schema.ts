import { z } from 'zod';

const emailSchema = z.string().email().max(320);
const passwordSchema = z.string().min(10).max(200);
const opaqueTokenSchema = z.string().min(20).max(512);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const emailRequestSchema = z.object({
  email: emailSchema,
});

export const verifyEmailSchema = z.object({
  token: opaqueTokenSchema,
});

export const resetPasswordSchema = z.object({
  token: opaqueTokenSchema,
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type EmailRequestInput = z.infer<typeof emailRequestSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
