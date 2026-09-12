import { z } from 'zod'
import type { Request, Response } from 'express'
import { buildingRepository, BuildingType } from '../database/repositories/buildingRepository'
import { asyncHandler, ApiError } from '../utils/errors'
import { serializeBuilding } from '../utils/serializers'
import { parseBody } from '../utils/validate'

// Helper to ensure userId is retrieved
function requireUserId(req: Request): string {
  const userId = req.user?.id
  if (!userId) throw new ApiError(401, 'Authentication required')
  return userId
}

const listBuildingsSchema = z.object({
  type: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius: z.coerce.number().positive().max(100).optional(),
})

const createBuildingSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['govt', 'hospital', 'heritage', 'transport', 'emergency', 'banking', 'education', 'worship']),
  address: z.string().min(1),
  timings: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  services: z.array(z.string()).optional(),
  description: z.string().optional().nullable(),
  location_lat: z.number().optional().nullable(),
  location_lng: z.number().optional().nullable(),
})

const BUILDING_SECTIONS: { key: string; label: string; types: BuildingType[] }[] = [
  { key: 'important', label: 'Important Buildings', types: ['govt', 'banking', 'education'] },
  { key: 'heritage', label: 'Heritage', types: ['heritage', 'worship'] },
  { key: 'emergency', label: 'Emergency', types: ['emergency', 'hospital'] },
  { key: 'transport', label: 'Transport', types: ['transport'] },
]

export const getGuide = asyncHandler(async (_req: Request, res: Response) => {
  const all = buildingRepository.findGuide('rewari') // default cityId
  const sections = BUILDING_SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    buildings: all.filter((b) => section.types.includes(b.type)).map(serializeBuilding),
  }))
  res.json({ sections })
})

export const listBuildings = asyncHandler(async (req: Request, res: Response) => {
  const { type } = listBuildingsSchema.parse(req.query)

  const result = buildingRepository.findAll({ limit: 100 }, { type: type as BuildingType })
  res.json({ buildings: result.items.map(serializeBuilding) })
})

export const createBuilding = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req)
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the Super Admin can create landmarks')
  }
  const data = parseBody(req, createBuildingSchema)
  const b = buildingRepository.create({
    name: data.name,
    type: data.type,
    address: data.address,
    services: data.services,
    timings: data.timings ?? undefined,
    contact: data.contact ?? undefined,
    description: data.description ?? undefined,
    location_lat: data.location_lat ?? undefined,
    location_lng: data.location_lng ?? undefined,
  })
  res.status(201).json({ building: serializeBuilding(b) })
})

export const updateBuilding = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req)
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the Super Admin can update landmarks')
  }
  const data = parseBody(req, createBuildingSchema.partial())
  const b = buildingRepository.update(req.params.id, {
    ...data,
    timings: data.timings ?? undefined,
    contact: data.contact ?? undefined,
    description: data.description ?? undefined,
    location_lat: data.location_lat ?? undefined,
    location_lng: data.location_lng ?? undefined,
  })
  if (!b) throw new ApiError(404, 'Landmark not found')
  res.json({ building: serializeBuilding(b) })
})

export const deleteBuilding = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req)
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Only the Super Admin can delete landmarks')
  }
  const success = buildingRepository.delete(req.params.id)
  if (!success) throw new ApiError(404, 'Landmark not found')
  res.json({ ok: true })
})
