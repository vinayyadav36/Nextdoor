import { z } from 'zod'
import type { Request, Response } from 'express'
import { asyncHandler } from '../utils/errors'
import { env } from '../config/env'

const routeSchema = z.object({
  fromLat: z.coerce.number().min(-90).max(90),
  fromLng: z.coerce.number().min(-180).max(180),
  toLat: z.coerce.number().min(-90).max(90),
  toLng: z.coerce.number().min(-180).max(180),
})

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

export const getRoute = asyncHandler(async (req: Request, res: Response) => {
  const { fromLat, fromLng, toLat, toLng } = routeSchema.parse(req.query)

  // Straight line fallback distance
  const distanceKm = haversineKm(fromLat, fromLng, toLat, toLng)

  try {
    const response = await fetch(
      `${env.osmrBaseUrl}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`
    )
    if (!response.ok) {
      throw new Error(`OSRM API error: ${response.status}`)
    }
    const data = await response.json() as any

    if (data.code !== 'Ok') {
      throw new Error(`OSRM routing error: ${data.code}`)
    }

    res.json({
      fallback: false,
      distanceKm: data.routes[0].distance / 1000,
      durationSec: data.routes[0].duration,
      geometry: data.routes[0].geometry,
    })
  } catch (err) {
    // Return straight-line fallback if OSRM is blocked/fails
    res.json({
      fallback: true,
      straightLine: {
        type: 'LineString',
        coordinates: [
          [fromLng, fromLat],
          [toLng, toLat]
        ]
      },
      distanceKm,
    })
  }
})
