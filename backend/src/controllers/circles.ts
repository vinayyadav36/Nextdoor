import { z } from 'zod'
import type { Request, Response } from 'express'
import { circleRepository } from '../database/repositories/circleRepository'
import { channelRepository } from '../database/repositories/channelRepository'
import { userRepository } from '../database/repositories/userRepository'
import { messageRepository } from '../database/repositories/messageRepository'
import { transientStore } from '../utils/transientStore'
import { ApiError, asyncHandler } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { requireUserId } from '../middleware/auth'
import { serializeChannel } from '../utils/serializers'
import { generateId } from '../database/repositories/base'
import { getDatabase } from '../database/connection'

const createCircleSchema = z.object({
  name: z.string().min(1, 'Circle name is required').max(60),
  description: z.string().max(300).optional().or(z.literal('')),
  initialChannel: z.string().min(1).max(60).optional().or(z.literal('')),
  pin: z.string().min(1, 'A security PIN is required to protect this circle').max(20),
})

const createChannelSchema = z.object({
  name: z.string().min(1, 'Channel name is required').max(60),
  pin: z.string().min(1, 'A channel PIN is required').max(20),
})

const createMessageSchema = z.object({
  content: z.string().min(1, 'Message is required').max(1000),
  expiresIn: z.enum(['none', '10m', '1h', '1d', '1w']).default('none'),
})

const listCirclesSchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

export const listCircles = asyncHandler(async (req: Request, res: Response) => {
  const { page = 1, limit = 20 } = listCirclesSchema.parse(req.query)
  const offset = (page - 1) * limit
  const result = circleRepository.findAll({ limit, offset })
  const userId = req.user?.id

  const circles = result.items.map((c) => {
    // Check membership and role
    const isMem = userId ? circleRepository.isMember(c.id, userId) : false
    const role = userId ? circleRepository.getRole(c.id, userId) : null
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      channelCount: circleRepository.getChannelCount(c.id),
      createdAt: c.created_at,
      hasPin: !!c.pin,
      pin: req.user?.role === 'admin' ? c.pin : undefined,
      isMember: isMem,
      role
    }
  })

  res.json({
    circles,
    total: result.total,
    page,
    pages: Math.ceil(result.total / limit)
  })
})

export const createCircle = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { name, description, initialChannel, pin } = parseBody(req, createCircleSchema)

  const circle = circleRepository.create({
    name,
    description: description ?? '',
    creator_id: userId,
    pin,
  })

  let channel = null
  if (initialChannel && initialChannel.trim()) {
    channel = channelRepository.create({
      name: initialChannel.trim(),
      circle_id: circle.id,
      pin: undefined
    })
  }

  res.status(201).json({
    circle: {
      id: circle.id,
      name,
      description: description ?? '',
      channelCount: channel ? 1 : 0,
      createdAt: circle.created_at,
      hasPin: !!circle.pin,
      isMember: true,
      role: 'admin'
    },
    channel: channel ? serializeChannel(channel) : null,
  })
})

export const verifyCirclePin = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { pin } = parseBody(req, z.object({ pin: z.string() }))
  
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  if (circle.pin && circle.pin !== pin) {
    throw new ApiError(401, 'Invalid PIN')
  }

  // Add as member if valid
  circleRepository.addMember(circle.id, userId, 'member')
  res.json({ ok: true, role: 'member' })
})

export const requestCircleAccess = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  circleRepository.createRequest(circle.id, userId)
  res.json({ ok: true, status: 'pending' })
})

export const listCircleRequests = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const userRole = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)
  if (userRole !== 'admin' && userRole !== 'co_admin') {
    throw new ApiError(403, 'Only admins and co-admins can review requests')
  }

  const requests = circleRepository.getPendingRequests(circle.id)
  res.json({ requests })
})

export const resolveCircleRequest = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { id: circleId, requestId } = req.params
  const { status } = parseBody(req, z.object({ status: z.enum(['approved', 'rejected']) }))

  const circle = circleRepository.findById(circleId)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const userRole = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)
  if (userRole !== 'admin' && userRole !== 'co_admin') {
    throw new ApiError(403, 'Only admins and co-admins can resolve requests')
  }

  const request = circleRepository.getRequestById(requestId)
  if (!request) throw new ApiError(404, 'Request not found')

  circleRepository.updateRequestStatus(requestId, status)

  if (status === 'approved') {
    circleRepository.addMember(circleId, request.user_id, 'member')
  }

  res.json({ ok: true })
})

export const updateMemberRole = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { id: circleId, userId: targetUserId } = req.params
  const { role } = parseBody(req, z.object({ role: z.enum(['member', 'elder', 'co_admin', 'admin']) }))

  const circle = circleRepository.findById(circleId)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const userRole = isSystemAdmin ? 'admin' : circleRepository.getRole(circleId, userId)
  if (userRole !== 'admin' && userRole !== 'co_admin') {
    throw new ApiError(403, 'Only Admin and Co-admins can manage roles')
  }

  if (role === 'co_admin' && userRole !== 'admin') {
    throw new ApiError(403, 'Only the Admin can promote members to Co-admin')
  }

  if (role === 'admin' && userRole !== 'admin') {
    throw new ApiError(403, 'Only the Admin can transfer Admin status')
  }

  // Enforce role limits
  if (role === 'admin') {
    // Transfer admin status: target becomes admin, caller becomes member/co_admin
    circleRepository.updateMemberRole(circleId, targetUserId, 'admin')
    if (!isSystemAdmin) {
      circleRepository.updateMemberRole(circleId, userId, 'co_admin')
    }
  } else if (role === 'co_admin') {
    const count = circleRepository.countMembersWithRole(circleId, 'co_admin')
    if (count >= 3 && !isSystemAdmin) {
      throw new ApiError(400, 'Cannot have more than 3 co-admins in a circle')
    }
    circleRepository.updateMemberRole(circleId, targetUserId, 'co_admin')
  } else if (role === 'elder') {
    const count = circleRepository.countMembersWithRole(circleId, 'elder')
    if (count >= 7 && !isSystemAdmin) {
      throw new ApiError(400, 'Cannot have more than 7 elders in a circle')
    }
    circleRepository.updateMemberRole(circleId, targetUserId, 'elder')
  } else {
    circleRepository.updateMemberRole(circleId, targetUserId, 'member')
  }

  res.json({ ok: true })
})

export const updateCirclePin = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { pin } = parseBody(req, z.object({ pin: z.string().max(20).optional().or(z.literal('')) }))

  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const userRole = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)
  if (userRole !== 'admin') {
    throw new ApiError(403, 'Only the circle Admin can manage the PIN')
  }

  circleRepository.updatePin(circle.id, pin || null)
  res.json({ ok: true })
})

export const updateCircle = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { name, description } = parseBody(req, z.object({
    name: z.string().min(1).max(60),
    description: z.string().max(300).optional().or(z.literal(''))
  }))

  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const userRole = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)
  if (userRole !== 'admin') {
    throw new ApiError(403, 'Only the circle Admin can modify settings')
  }

  // Update in SQLite
  const db = (circleRepository as any).db
  db.prepare('UPDATE circles SET name = ?, description = ? WHERE id = ?').run(name, description || '', circle.id)

  res.json({ ok: true })
})

export const getCircle = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const isMember = isSystemAdmin || circleRepository.isMember(circle.id, userId)
  const role = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)

  res.json({
    circle: {
      id: circle.id,
      name: circle.name,
      description: circle.description,
      hasPin: !!circle.pin,
      pin: isSystemAdmin ? circle.pin : undefined,
      isMember,
      role
    }
  })
})

export const listChannels = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const circleId = req.params.id
  
  const circle = circleRepository.findById(circleId)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const isMem = isSystemAdmin || circleRepository.isMember(circleId, userId)
  if (!isMem) {
    throw new ApiError(403, 'You must be a member to access these channels')
  }

  const result = channelRepository.findByCircleId(circleId, { limit: 100 })
  res.json({
    channels: result.items.map((ch) => ({
      ...serializeChannel(ch),
      hasPin: !!ch.pin,
      pin: isSystemAdmin ? ch.pin : undefined
    }))
  })
})

export const createChannel = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { name, pin } = parseBody(req, createChannelSchema)
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const role = isSystemAdmin ? 'admin' : circleRepository.getRole(circle.id, userId)
  if (role !== 'admin' && role !== 'co_admin') {
    throw new ApiError(403, 'Only Admin and Co-admins can create channels')
  }

  const channel = channelRepository.create({ name, circle_id: circle.id, pin })
  res.status(201).json({ channel: { ...serializeChannel(channel), hasPin: !!channel.pin } })
})

export const verifyChannelPin = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req)
  const { pin } = parseBody(req, z.object({ pin: z.string() }))
  
  const channel = channelRepository.findById(req.params.id)
  if (!channel) throw new ApiError(404, 'Channel not found')

  if (channel.pin && channel.pin !== pin) {
    throw new ApiError(401, 'Invalid Channel PIN')
  }

  res.json({ ok: true })
})

export const updateChannelPin = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { pin } = parseBody(req, z.object({ pin: z.string().max(20).optional().or(z.literal('')) }))
  
  const channel = channelRepository.findById(req.params.id)
  if (!channel) throw new ApiError(404, 'Channel not found')

  const isSystemAdmin = req.user?.role === 'admin'
  const circleRole = isSystemAdmin ? 'admin' : circleRepository.getRole(channel.circle_id, userId)
  if (circleRole !== 'admin' && !isSystemAdmin) {
    throw new ApiError(403, 'Only the circle Admin can manage channel security')
  }

  channelRepository.updatePin(channel.id, pin || null)
  res.json({ ok: true })
})

export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const channel = channelRepository.findById(req.params.id)
  if (!channel) throw new ApiError(404, 'Channel not found')

  const isMem = circleRepository.isMember(channel.circle_id, userId) || req.user?.role === 'admin'
  if (!isMem) {
    throw new ApiError(403, 'You must be a member of the circle to view chat')
  }

  const isSystemAdmin = req.user?.role === 'admin'
  const messages = transientStore.getMessages(channel.id)
  
  let enrichedMessages = messages
  if (isSystemAdmin) {
    try {
      const db = getDatabase()
      enrichedMessages = messages.map((m) => {
        const authorId = m.user_id
        if (authorId) {
          const conn = db.prepare('SELECT ip, device_type, os, browser, lat, lng FROM user_connections WHERE user_id = ? ORDER BY connected_at DESC LIMIT 1').get(authorId) as any
          if (conn) {
            return {
              ...m,
              senderConnection: {
                ip: conn.ip,
                deviceType: conn.device_type,
                os: conn.os,
                browser: conn.browser,
                lat: conn.lat,
                lng: conn.lng
              }
            }
          }
        }
        return m
      })
    } catch (e) {
      console.error('Failed to enrich chat message metadata:', e)
    }
  }

  res.json({ messages: enrichedMessages })
})

function calculateExpiresAt(expiresIn?: string): Date | null {
  if (!expiresIn) return null
  const now = new Date()
  switch (expiresIn) {
    case '10m':
      return new Date(now.getTime() + 10 * 60 * 1000)
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000)
    case '1d':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000)
    case '1w':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    case 'none':
    default:
      return null
  }
}

export const createMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { content, expiresIn } = parseBody(req, createMessageSchema)
  const channel = channelRepository.findById(req.params.id)
  if (!channel) throw new ApiError(404, 'Channel not found')

  const isMem = circleRepository.isMember(channel.circle_id, userId) || req.user?.role === 'admin'
  if (!isMem) {
    throw new ApiError(403, 'You must join this circle first')
  }

  const user = userRepository.findById(userId)
  const expiresAt = calculateExpiresAt(expiresIn)

  const messageId = generateId()
  const message = transientStore.addMessage({
    id: messageId,
    content,
    channel_id: channel.id,
    user_id: userId,
    author_name: user?.name || 'Neighbor',
    type: 'text',
    paste_id: null,
    expires_at: expiresAt ? expiresAt.toISOString() : null
  })

  // Persist to SQLite so history survives restarts and is available to the super admin.
  try {
    messageRepository.create({
      id: messageId,
      content,
      channel_id: channel.id,
      user_id: userId,
      author_name: user?.name || 'Neighbor',
      type: 'text',
      paste_id: undefined,
      expires_at: expiresAt
    })
  } catch (e) {
    console.error('Failed to persist message to DB:', e)
  }

  res.status(201).json({ message })
})

export const listCircleMembers = asyncHandler(async (req: Request, res: Response) => {
  const circleId = req.params.id
  const circle = circleRepository.findById(circleId)
  if (!circle) throw new ApiError(404, 'Circle not found')
  
  const members = circleRepository.getMembers(circleId)
  const detailedMembers = members.map((m) => {
    const user = userRepository.findById(m.user_id)
    return {
      userId: m.user_id,
      name: user?.name || 'Unknown User',
      email: user?.email || '',
      role: m.role,
      joinedAt: m.joined_at
    }
  })
  res.json({ members: detailedMembers })
})

export const deleteCircle = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const circle = circleRepository.findById(req.params.id)
  if (!circle) throw new ApiError(404, 'Circle not found')

  const role = circleRepository.getRole(circle.id, userId)
  if (role !== 'admin' && req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the circle creator or system admin can delete this circle')
  }

  circleRepository.softDelete(circle.id)
  res.json({ ok: true })
})

export const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { channelId, messageId } = req.params

  const channel = channelRepository.findById(channelId)
  if (!channel) throw new ApiError(404, 'Channel not found')

  const isMem = circleRepository.isMember(channel.circle_id, userId) || req.user?.role === 'admin'
  if (!isMem) throw new ApiError(403, 'Must join the circle first')

  const messages = transientStore.getMessages(channelId)
  const msg = messages.find((m) => m.id === messageId)
  if (!msg) throw new ApiError(404, 'Message not found')

  if (msg.user_id !== userId && req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the author or system admin can delete this message')
  }

  transientStore.deleteMessage(channelId, messageId)
  try {
    messageRepository.softDelete(messageId)
  } catch (e) {
    console.error('Failed to soft-delete message in DB:', e)
  }
  res.json({ ok: true })
})
