import { BaseRepository, generateId, now, QueryOptions, PaginatedResult } from './base'

export const BUSINESS_CATEGORIES = [
  'Food',
  'Healthcare',
  'Govt',
  'Banking',
  'Education',
  'Worship',
  'Transport',
  'Shopping',
  'Services',
  'Emergency',
] as const

export type BusinessCategory = typeof BUSINESS_CATEGORIES[number]


export interface Business {
  id: string
  name: string
  slug: string
  category: string
  subcategory: string | null
  tags: string[]
  description: string | null
  address: string
  phone: string
  whatsapp: string | null
  hours: Record<string, { open?: string; close?: string }>
  photos: string[]
  attributes: { parking: boolean; cards: boolean; homeDelivery: boolean }
  owner_id: string | null
  verified: boolean
  verified_at: Date | null
  plan: 'free' | 'promoted'
  rating_avg: number
  rating_count: number
  status: 'active' | 'pending' | 'suspended'
  location_lat: number
  location_lng: number
  locality_id: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface CreateBusinessInput {
  name: string
  slug: string
  category: string
  subcategory?: string
  tags?: string[]
  description?: string
  address: string
  phone: string
  whatsapp?: string
  hours?: Record<string, { open?: string; close?: string }>
  photos?: string[]
  attributes?: { parking: boolean; cards: boolean; homeDelivery: boolean }
  owner_id?: string
  verified?: boolean
  plan?: 'free' | 'promoted'
  status?: 'active' | 'pending' | 'suspended'
  location_lat: number
  location_lng: number
  locality_id?: string
}

export interface UpdateBusinessInput {
  name?: string
  slug?: string
  category?: string
  subcategory?: string
  tags?: string[]
  description?: string
  address?: string
  phone?: string
  whatsapp?: string
  hours?: Record<string, { open?: string; close?: string }>
  photos?: string[]
  attributes?: { parking: boolean; cards: boolean; homeDelivery: boolean }
  owner_id?: string | null
  verified?: boolean
  plan?: 'free' | 'promoted'
  status?: 'active' | 'pending' | 'suspended'
  location_lat?: number
  location_lng?: number
  locality_id?: string | null
  rating_avg?: number
  rating_count?: number
  priority?: number
}

export class BusinessRepository extends BaseRepository {
  private table = 'businesses'

  findById(id: string): Business | null {
    const row = this.executeQueryOne<Business>(`SELECT * FROM ${this.table} WHERE id = ? AND deleted_at IS NULL`, [id])
    return row ? this.deserializeBusiness(row) : null
  }

  findBySlug(slug: string): Business | null {
    const row = this.executeQueryOne<Business>(`SELECT * FROM ${this.table} WHERE slug = ? AND deleted_at IS NULL`, [slug])
    return row ? this.deserializeBusiness(row) : null
  }

  findAll(options: QueryOptions = {}, filters: { category?: string; locality_id?: string; status?: string; verified?: boolean; search?: string } = {}): PaginatedResult<Business> {
    const conditions: string[] = ['deleted_at IS NULL']
    const params: unknown[] = []

    if (filters.category) {
      conditions.push('category = ?')
      params.push(filters.category)
    }
    if (filters.locality_id) {
      conditions.push('locality_id = ?')
      params.push(filters.locality_id)
    }
    if (filters.status) {
      conditions.push('status = ?')
      params.push(filters.status)
    }
    if (filters.verified !== undefined) {
      conditions.push('verified = ?')
      params.push(filters.verified ? 1 : 0)
    }
    if (filters.search) {
      conditions.push('(name LIKE ? OR tags LIKE ? OR description LIKE ?)')
      const searchTerm = `%${filters.search}%`
      params.push(searchTerm, searchTerm, searchTerm)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const { query, params: queryParams } = this.buildSelectQuery(this.table, options, where, params)
    const { query: countQuery, params: countParams } = this.buildCountQuery(this.table, where, params)
    
    const items = this.executeQuery<Business>(query, queryParams).map(r => this.deserializeBusiness(r))
    const total = this.executeQueryOne<{ count: number }>(countQuery, countParams)?.count || 0
    
    return {
      items,
      total,
      page: Math.floor((options.offset || 0) / (options.limit || 50)) + 1,
      pageSize: options.limit || 50,
      totalPages: Math.ceil(total / (options.limit || 50))
    }
  }

  findNearby(lat: number, lng: number, radiusKm: number, options: QueryOptions = {}, filters: { category?: string } = {}): PaginatedResult<Business> {
    const conditions: string[] = [
      'deleted_at IS NULL',
      'location_lat IS NOT NULL',
      'location_lng IS NOT NULL',
      '(6371 * acos(cos(radians(?)) * cos(radians(location_lat)) * cos(radians(location_lng) - radians(?)) + sin(radians(?)) * sin(radians(location_lat)))) <= ?'
    ]
    const params: unknown[] = [lat, lng, lat, radiusKm]

    if (filters.category) {
      conditions.push('category = ?')
      params.push(filters.category)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const { query, params: queryParams } = this.buildSelectQuery(this.table, options, where, params)
    const { query: countQuery, params: countParams } = this.buildCountQuery(this.table, where, params)
    
    const items = this.executeQuery<Business>(query, queryParams).map(r => this.deserializeBusiness(r))
    const total = this.executeQueryOne<{ count: number }>(countQuery, countParams)?.count || 0
    
    return {
      items,
      total,
      page: Math.floor((options.offset || 0) / (options.limit || 50)) + 1,
      pageSize: options.limit || 50,
      totalPages: Math.ceil(total / (options.limit || 50))
    }
  }

  create(input: CreateBusinessInput): Business {
    const id = generateId()
    const timestamp = now()
    
    this.executeRun(
      `INSERT INTO ${this.table} (id, name, slug, category, subcategory, tags, description, address, phone, whatsapp, hours, photos, attributes, owner_id, verified, verified_at, plan, rating_avg, rating_count, status, location_lat, location_lng, locality_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.name, input.slug, input.category, input.subcategory || null,
        JSON.stringify(input.tags || []), input.description || null, input.address, input.phone, input.whatsapp || null,
        JSON.stringify(input.hours || {}), JSON.stringify(input.photos || []), JSON.stringify(input.attributes || { parking: false, cards: false, homeDelivery: false }),
        input.owner_id || null, input.verified ? 1 : 0, input.verified ? timestamp : null,
        input.plan || 'free', 0, 0, input.status || 'active',
        input.location_lat, input.location_lng, input.locality_id || null, timestamp, timestamp
      ]
    )
    
    return this.findById(id)!
  }

  update(id: string, input: UpdateBusinessInput): Business | null {
    const existing = this.findById(id)
    if (!existing) return null

    const updates: string[] = []
    const params: unknown[] = []

    const fieldMap: Record<string, string> = {
      name: 'name',
      slug: 'slug',
      category: 'category',
      subcategory: 'subcategory',
      tags: 'tags',
      description: 'description',
      address: 'address',
      phone: 'phone',
      whatsapp: 'whatsapp',
      hours: 'hours',
      photos: 'photos',
      attributes: 'attributes',
      owner_id: 'owner_id',
      verified: 'verified',
      plan: 'plan',
      status: 'status',
      location_lat: 'location_lat',
      location_lng: 'location_lng',
      locality_id: 'locality_id',
      rating_avg: 'rating_avg',
      rating_count: 'rating_count',
      priority: 'priority'
    }

    for (const [key, column] of Object.entries(fieldMap)) {
      const value = (input as Record<string, unknown>)[key]
      if (value !== undefined) {
        updates.push(`${column} = ?`)
        if (['tags', 'hours', 'photos', 'attributes'].includes(key)) {
          params.push(JSON.stringify(value))
        } else if (key === 'verified') {
          params.push(value ? 1 : 0)
        } else {
          params.push(value)
        }
      }
    }

    if (input.verified === true && !existing.verified) {
      updates.push('verified_at = ?')
      params.push(now())
    }

    if (updates.length === 0) return existing

    updates.push('updated_at = ?')
    params.push(now())
    params.push(id)

    this.executeRun(`UPDATE ${this.table} SET ${updates.join(', ')} WHERE id = ?`, params)
    return this.findById(id)
  }

  updateRating(id: string): Business | null {
    const row = this.executeQueryOne<{ avg: number; count: number }>(
      `SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE business_id = ? AND deleted_at IS NULL`,
      [id]
    )
    if (row) {
      return this.update(id, { 
        rating_avg: Math.round((row.avg || 0) * 10) / 10,
        rating_count: row.count || 0
      })
    }
    return this.findById(id)
  }

  softDelete(id: string): boolean {
    const result = this.executeRun(
      `UPDATE ${this.table} SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [now(), now(), id]
    )
    return result.changes > 0
  }

  private deserializeBusiness(row: any): Business {
    const deserialized = this.deserializeDates(row)
    return {
      ...deserialized,
      tags: this.parseJsonField(deserialized.tags, []),
      hours: this.parseJsonField(deserialized.hours, {}),
      photos: this.parseJsonField(deserialized.photos, []),
      attributes: this.parseJsonField(deserialized.attributes, { parking: false, cards: false, homeDelivery: false }),
      verified: Boolean(deserialized.verified)
    }
  }
}

export const businessRepository = new BusinessRepository()