export interface LatLng {
  lat: number
  lng: number
}

export type BusinessCategory =
  | 'Food'
  | 'Healthcare'
  | 'Govt'
  | 'Banking'
  | 'Education'
  | 'Worship'
  | 'Transport'
  | 'Shopping'
  | 'Services'
  | 'Emergency'

export interface Business {
  id: string
  name: string
  slug: string
  category: BusinessCategory
  subcategory: string | null
  tags: string[]
  address: string
  phone: string
  whatsapp: string | null
  hours: Record<string, { open?: string; close?: string }>
  photos: string[]
  attributes: { parking: boolean; cards: boolean; homeDelivery: boolean }
  ownerId: string | null
  verified: boolean
  plan: 'free' | 'promoted'
  ratingAvg: number
  ratingCount: number
  status: 'active' | 'pending' | 'suspended'
  description: string | null
  location: LatLng | null
  priority?: number
  createdAt: string
}

export interface Post {
  id: string
  content: string
  authorName: string
  imageUrl: string | null
  createdAt: string
  userId: string
  location: LatLng | null
  senderConnection?: {
    ip: string
    deviceType: string
    os: string
    browser: string
    lat: number | null
    lng: number | null
  }
}

export interface Comment {
  id: string
  content: string
  postId: string
  authorName: string
  userId: string
  createdAt: string
}

export interface Review {
  id: string
  businessId: string
  userId: string
  rating: number
  text: string
  ownerReply: string | null
  createdAt: string
}

export interface Offer {
  id: string
  businessId: string
  title: string
  discount: string
  code: string | null
  validFrom: string
  validTo: string
  status: 'active' | 'expired'
}

export interface Circle {
  id: string
  name: string
  description: string
  channelCount: number
  hasPin?: boolean
  pin?: string
  isMember?: boolean
  role?: 'admin' | 'co_admin' | 'elder' | 'member' | null
  createdAt: string
}

export interface Channel {
  id: string
  name: string
  circleId: string
  hasPin?: boolean
  pin?: string
  createdAt: string
}

export interface Message {
  id: string
  content: string
  channelId: string
  userId: string
  authorName: string
  createdAt: string
  expiresAt?: string | null
}

export interface BusinessClaimRequest {
  id: string
  businessId: string
  businessName?: string
  requesterId: string
  requesterName?: string
  requesterEmail?: string
  privateContactName: string
  privateContactPhone: string
  privateContactEmail: string
  verificationNote: string | null
  evidenceReference: string | null
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  adminNote: string | null
  createdAt: string
}

export interface Article {
  id: string
  slug: string
  title: string
  contentMarkdown: string
  category: 'history' | 'heritage' | 'places' | 'services' | 'businesses' | 'events' | 'future' | 'guides'
  locality: string | null
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived'
  authorId: string
  sourceReference: string | null
  publishedAt: string | null
  createdAt: string
}

export interface Building {
  id: string
  name: string
  type: string
  address: string
  timings: string | null
  contact: string | null
  services: string[]
  description: string | null
  photos: string[]
  location: LatLng | null
}

export interface EmergencyContact {
  id?: string
  name: string
  type: 'police' | 'ambulance' | 'fire' | 'women' | 'other'
  phone: string
  address?: string
  location?: LatLng | null
}

export interface User {
  id: string
  name: string
  email: string
  role: 'user' | 'owner' | 'admin'
  points: number
  savedPlaces: string[]
}

export interface UserProfileEntry {
  id: string
  content: string
  channelId?: string
  channelName?: string
  circleId?: string
  circleName?: string
  createdAt: string | null
  expiresAt?: string | null
}

export interface UserProfile {
  user: {
    id: string
    name: string
    email: string
    role: 'user' | 'owner' | 'admin'
    points: number
    lastSeenAt?: string | null
    lastLat?: number | null
    lastLng?: number | null
    createdAt: string | null
  }
  masked: boolean
  isSelf: boolean
  stats: { posts: number; messages: number }
  timeline: UserProfileEntry[]
  chats: UserProfileEntry[]
  connectionLogs?: {
    id: string
    userId: string
    ip: string
    userAgent: string
    deviceType: string
    os: string
    browser: string
    lat: number | null
    lng: number | null
    connectedAt: string | null
  }[]
  loginCount?: number
}

export interface AdminUserEntry {
  id: string
  name: string
  email: string
  role: 'user' | 'owner' | 'admin'
  points: number
  lastSeenAt?: string | null
  lastLat?: number | null
  lastLng?: number | null
  createdAt: string | null
  postCount: number
  messageCount: number
}

export interface AuthResponse {
  token: string
  user: User
}

export interface BusinessListResponse {
  businesses: Business[]
  total: number
  page: number
  pages: number
}

export interface CircleListResponse {
  circles: Circle[]
}
