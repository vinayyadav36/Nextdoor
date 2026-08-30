import { z } from 'zod'
import type { Request, Response } from 'express'
import { createClerkClient, verifyToken } from '@clerk/backend'
import { userRepository } from '../database/repositories/userRepository'
import { signToken } from '../utils/jwt'
import { ApiError, asyncHandler } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { serializeUser } from '../utils/serializers'
import { env } from '../config/env'

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new ApiError(401, 'Not authenticated')
  const user = userRepository.findById(req.user.id)
  if (!user) throw new ApiError(404, 'User not found')
  res.json({ user: serializeUser(user) })
})

export const logout = (_req: Request, res: Response) => {
  res.json({ ok: true })
}

const clerkSyncSchema = z.object({
  sessionToken: z.string().min(1, 'Clerk session token is required'),
})

export const clerkSync = asyncHandler(async (req: Request, res: Response) => {
  const { sessionToken } = parseBody(req, clerkSyncSchema)

  if (!env.clerkSecretKey) {
    throw new ApiError(500, 'Clerk is not configured on the server (CLERK_SECRET_KEY missing)')
  }

  // Verify the Clerk session JWT server-side. The token is only issued by Clerk
  // after the email verification code has been completed, so a valid token is
  // proof that the user really owns that email address.
  const clerkClient = createClerkClient({ secretKey: env.clerkSecretKey })
  let claims: { sub?: string }
  try {
    claims = await verifyToken(sessionToken, {
      secretKey: env.clerkSecretKey,
      authorizedParties: env.corsOrigin,
    })
  } catch (err: any) {
    console.error('Clerk token verification failed:', err)
    throw new ApiError(401, 'Invalid or expired Clerk session token')
  }

  if (!claims.sub) {
    throw new ApiError(401, 'Clerk session token missing user id')
  }

  // Resolve the verified Clerk user to get their primary email + full name.
  const clerkUser = await clerkClient.users.getUser(claims.sub)
  const emailNorm = (clerkUser.primaryEmailAddress?.emailAddress ?? '').toLowerCase().trim()
  if (!emailNorm) {
    throw new ApiError(401, 'Clerk user has no verified primary email')
  }

  const firstName = clerkUser.firstName || ''
  const lastName = clerkUser.lastName || ''
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || emailNorm.split('@')[0]

  let user = userRepository.findByEmail(emailNorm)
  if (!user) {
    user = userRepository.create({
      email: emailNorm,
      name,
      password_hash: '',
    })
  } else if (name && name !== user.name) {
    user = userRepository.update(user.id, { name }) ?? user
  }

  // Generate a standard JWT auth token for the app's local requests
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  res.json({ token, user: serializeUser(user) })
})
