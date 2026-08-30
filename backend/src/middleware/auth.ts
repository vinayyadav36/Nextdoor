import type { NextFunction, Request, Response } from 'express'
import { userRepository } from '../database/repositories/userRepository'
import { verifyToken } from '../utils/jwt'
import { ApiError } from '../utils/errors'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string
        email: string
        phone?: string
        role: 'user' | 'owner' | 'admin'
      }
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Not authenticated'))
  }

  const token = header.slice(7)
  let payload: ReturnType<typeof verifyToken>
  try {
    payload = verifyToken(token)
  } catch {
    return next(new ApiError(401, 'Invalid or expired token'))
  }

  try {
    const user = userRepository.findById(payload.userId)
    if (!user) return next(new ApiError(401, 'User no longer exists'))
    req.user = { id: user.id, email: user.email, role: user.role }
    next()
  } catch {
    next(new ApiError(500, 'Authentication error'))
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return next(new ApiError(403, 'Admin access required'))
  }
  next()
}

export function requireUserId(req: Request): string {
  if (!req.user?.id) {
    throw new ApiError(401, 'Authentication required')
  }
  return req.user.id
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return next()
  }

  const token = header.slice(7)
  try {
    const payload = verifyToken(token)
    const user = userRepository.findById(payload.userId)
    if (user) {
      req.user = { id: user.id, email: user.email, role: user.role }
    }
  } catch {
    // Ignore invalid/expired tokens for optional auth
  }
  next()
}
