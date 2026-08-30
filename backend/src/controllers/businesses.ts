import { z } from 'zod'
import type { Request, Response } from 'express'
import { businessRepository, BUSINESS_CATEGORIES } from '../database/repositories/businessRepository'
import { businessClaimRepository } from '../database/repositories/businessClaimRepository'
import { reviewRepository } from '../database/repositories/reviewRepository'
import { offerRepository } from '../database/repositories/offerRepository'
import { userRepository } from '../database/repositories/userRepository'
import { userSavedPlacesRepository } from '../database/repositories/userSavedPlacesRepository'
import { ApiError, asyncHandler } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { requireUserId } from '../middleware/auth'
import {
  serializeBusiness,
  serializeOffer,
  serializeReview,
  serializeUser,
} from '../utils/serializers'

const createBusinessSchema = z.object({
  name: z.string().min(1, 'Name is required').max(80),
  category: z.enum(BUSINESS_CATEGORIES as unknown as [string, ...string[]]),
  subcategory: z.string().max(40).optional().or(z.literal('')),
  description: z.string().max(2000).optional().or(z.literal('')),
  address: z.string().min(3, 'Address is required').max(200),
  phone: z.string().min(7, 'Phone is required').max(20),
  whatsapp: z.string().max(20).optional().or(z.literal('')),
  photos: z.array(z.string().url()).max(6).optional(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  tags: z.array(z.string().max(20)).max(12).optional(),
  attributes: z
    .object({
      parking: z.boolean().optional(),
      cards: z.boolean().optional(),
      homeDelivery: z.boolean().optional(),
    })
    .optional(),
  hours: z.record(z.object({ open: z.string(), close: z.string() })).optional(),
})

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1, 'Review text is required').max(1000),
})

const listBusinessesSchema = z.object({
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius: z.coerce.number().positive().max(100).optional(),
  category: z.string().optional(),
  q: z.string().optional(),
  verified: z.enum(['true', 'false']).optional(),
  openNow: z.enum(['true', 'false']).optional(),
  owner: z.string().optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).optional(),
})

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

function isOpenNow(hours: Record<string, { open: string; close: string }> | undefined): boolean {
  if (!hours) return true
  const now = new Date()
  const day = DAYS[now.getDay()]
  const slot = hours[day]
  if (!slot || !slot.open || !slot.close) return true
  const [oh, om] = slot.open.split(':').map(Number)
  const [ch, cm] = slot.close.split(':').map(Number)
  if ([oh, om, ch, cm].some((n) => Number.isNaN(n))) return true
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return nowMin >= oh * 60 + om && nowMin <= ch * 60 + cm
}

export const listBusinesses = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng, radius, category, q, verified, openNow, owner, page, limit } = listBusinessesSchema.parse(req.query)
  const pageNum = Math.max(page ?? 1, 1)
  const pageSize = Math.min(Math.max(limit ?? 20, 1), 50)
  const offset = (pageNum - 1) * pageSize

  const filters: any = { status: 'active' }
  if (category && category !== 'All') filters.category = category
  if (verified === 'true') filters.verified = true
  if (owner === 'me' && req.user) filters.owner_id = req.user.id
  if (q && q.trim()) filters.search = q.trim()

  let result
  if (lat !== undefined && lng !== undefined && radius !== undefined) {
    result = businessRepository.findNearby(lat, lng, radius, { limit: pageSize, offset }, filters)
  } else {
    result = businessRepository.findAll({ limit: pageSize, offset }, filters)
  }

  let items = result.items.map(serializeBusiness)
  if (openNow === 'true') {
    items = items.filter((b) => isOpenNow(b.hours as any))
  }

  res.json({
    businesses: items,
    page: pageNum,
    pages: Math.ceil(result.total / pageSize),
    total: result.total,
  })
})

export const createBusiness = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const data = parseBody(req, createBusinessSchema)
  const baseSlug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`

  const business = businessRepository.create({
    name: data.name,
    slug,
    category: data.category,
    subcategory: data.subcategory || undefined,
    description: data.description || undefined,
    address: data.address,
    phone: data.phone,
    whatsapp: data.whatsapp || undefined,
    photos: data.photos ?? [],
    tags: data.tags ?? [],
    attributes: {
      parking: data.attributes?.parking ?? false,
      cards: data.attributes?.cards ?? false,
      homeDelivery: data.attributes?.homeDelivery ?? false,
    },
    hours: data.hours ?? {},
    location_lat: data.lat,
    location_lng: data.lng,
    owner_id: userId,
  })

  res.status(201).json({ business: serializeBusiness(business) })
})

export const getBusinessBySlug = asyncHandler(async (req: Request, res: Response) => {
  const business = businessRepository.findBySlug(req.params.slug)
  if (!business) throw new ApiError(404, 'Business not found')

  const reviews = reviewRepository.findByBusinessId(business.id)
  const offers = offerRepository.findByBusinessId(business.id)

  res.json({
    business: serializeBusiness(business),
    reviews: reviews.map(serializeReview),
    offers: offers.map(serializeOffer),
  })
})

export const updateBusiness = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const business = businessRepository.findById(req.params.id)
  if (!business) throw new ApiError(404, 'Business not found')
  
  if (business.owner_id !== userId && req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the owner or an admin can edit this business')
  }

  const isAdmin = req.user?.role === 'admin'

  const {
    name, description, phone, whatsapp, photos, attributes, hours,
    address, category, subcategory, verified, owner_id, location_lat, location_lng, priority
  } = parseBody(
    req,
    z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(2000).optional().nullable(),
      phone: z.string().min(7).max(20).optional(),
      whatsapp: z.string().max(20).optional().nullable(),
      photos: z.array(z.string()).max(10).optional(),
      attributes: z.object({ parking: z.boolean().optional(), cards: z.boolean().optional(), homeDelivery: z.boolean().optional() }).optional(),
      hours: z.record(z.object({ open: z.string(), close: z.string() })).optional(),
      address: z.string().optional(),
      category: z.string().optional(),
      subcategory: z.string().optional().nullable(),
      verified: z.boolean().optional(),
      owner_id: z.string().optional().nullable(),
      location_lat: z.number().optional(),
      location_lng: z.number().optional(),
      priority: z.number().optional(),
    })
  )

  const updateFields: any = {
    name,
    description: description === null ? '' : description,
    phone,
    whatsapp: whatsapp === null ? '' : whatsapp,
    photos,
    attributes: attributes ? {
      parking: !!attributes.parking,
      cards: !!attributes.cards,
      homeDelivery: !!attributes.homeDelivery,
    } : undefined,
    hours
  }

  if (isAdmin) {
    if (address !== undefined) updateFields.address = address
    if (category !== undefined) updateFields.category = category
    if (subcategory !== undefined) updateFields.subcategory = subcategory ?? undefined
    if (verified !== undefined) updateFields.verified = verified
    if (owner_id !== undefined) updateFields.owner_id = owner_id ?? null
    if (location_lat !== undefined) updateFields.location_lat = location_lat
    if (location_lng !== undefined) updateFields.location_lng = location_lng
    if (priority !== undefined) updateFields.priority = priority
  }

  const updated = businessRepository.update(req.params.id, updateFields)
  res.json({ business: serializeBusiness(updated) })
})

export const claimBusiness = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const business = businessRepository.findById(req.params.id)
  if (!business) throw new ApiError(404, 'Business not found')
  if (business.owner_id) throw new ApiError(409, 'This business is already claimed')

  const { contactName, contactPhone, contactEmail, verificationNote, evidenceReference } = parseBody(
    req,
    z.object({
      contactName: z.string().min(1, 'Contact name is required'),
      contactPhone: z.string().min(7, 'Contact phone is required'),
      contactEmail: z.string().email('Enter a valid email address'),
      verificationNote: z.string().max(1000).optional().or(z.literal('')),
      evidenceReference: z.string().max(500).optional().or(z.literal('')),
    })
  )

  // Check if a pending claim already exists
  const existingClaim = businessClaimRepository.findByBusinessId(business.id)
  if (existingClaim && existingClaim.status === 'pending') {
    throw new ApiError(409, 'A claim request for this business is already pending')
  }

  const request = businessClaimRepository.create({
    business_id: business.id,
    requester_id: userId,
    private_contact_name: contactName,
    private_contact_phone: contactPhone,
    private_contact_email: contactEmail,
    verification_note: verificationNote || undefined,
    evidence_reference: evidenceReference || undefined,
  })

  res.status(201).json({ message: 'Claim request submitted successfully', request })
})

export const addReview = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { rating, text } = parseBody(req, reviewSchema)
  const business = businessRepository.findById(req.params.id)
  if (!business) throw new ApiError(404, 'Business not found')

  const existing = reviewRepository.findByUserAndBusiness(userId, business.id)
  if (existing) throw new ApiError(409, 'You have already reviewed this business')

  reviewRepository.create({
    business_id: business.id,
    user_id: userId,
    rating,
    text
  })

  // Recalculate average rating
  businessRepository.updateRating(business.id)

  const user = userRepository.findById(userId)
  if (user) {
    userRepository.addPoints(userId, 5)
  }

  res.status(201).json({ review: serializeReview(reviewRepository.findByUserAndBusiness(userId, business.id)!) })
})

export const toggleSave = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const business = businessRepository.findById(req.params.id)
  if (!business) throw new ApiError(404, 'Business not found')

  const user = userRepository.findById(userId)
  if (!user) return res.json({ saved: false, points: 0 })

  const wasSaved = userSavedPlacesRepository.isSaved(userId, business.id)
  let saved: boolean
  if (wasSaved) {
    userSavedPlacesRepository.unsave(userId, business.id)
    saved = false
  } else {
    userSavedPlacesRepository.save(userId, business.id)
    saved = true
    userRepository.addPoints(userId, 2)
  }

  const updatedUser = userRepository.findById(userId)!
  res.json({ saved, points: updatedUser.points })
})

export const listSaved = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const user = userRepository.findById(userId)
  if (!user) return res.json({ businesses: [] })

  const savedIds = userSavedPlacesRepository.getSavedBusinesses(userId)
  const saved = savedIds.map(id => businessRepository.findById(id)).filter(Boolean)
  res.json({ businesses: saved.map(serializeBusiness) })
})

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const user = userRepository.findById(userId)
  if (!user) throw new ApiError(404, 'User not found')
  res.json({ user: serializeUser(user) })
})
export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { name, email } = parseBody(
    req,
    z.object({
      name: z.string().min(1).max(60).optional(),
      email: z.string().email().optional().or(z.literal('')),
    })
  )
  const user = userRepository.findById(userId)
  if (!user) throw new ApiError(404, 'User not found')

  if (name && name !== user.name) {
    const taken = userRepository.findByName(name)
    if (taken && taken.id !== userId) {
      throw new ApiError(400, 'Username is already taken')
    }
  }

  const updated = userRepository.update(userId, {
    name,
    email: email || undefined
  })!
  res.json({ user: serializeUser(updated) })
})
export const deleteBusiness = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const business = businessRepository.findById(req.params.id)
  if (!business) throw new ApiError(404, 'Business not found')

  if (business.owner_id !== userId && req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the owner or an admin can delete this business')
  }

  businessRepository.softDelete(req.params.id)
  res.json({ ok: true })
})
