export { ApiError } from "./api/_helpers";

//importing product apis
export type {
  ProductStatus,
  ProductInput,
  Product,
  ProductWithViewCount,
  ReviewStatus,
  ArtisanSummary,
  ProductWithArtisan,
  MarketplaceSort,
  MarketplaceFilters,
  MarketplaceResult,
} from "./api/products";
export type { UserProfile } from "./api/users";
export type {
  RawMaterialItem,
  PricingSuggestionInput,
  PricingSuggestionOutput,
  MaterialCostAssessment,
  MaterialCostStatus,
} from "./api/pricing";
export type { UserRole, SelfServeRole, VerifyOtpResult } from "./api/auth";
export type {
  InquiryStatus,
  InquiryContactPreference,
  Inquiry,
  InquiryProductSummary,
  CreateInquiryInput,
} from "./api/inquiries";
export type {
  EnhanceResult,
  RemoveBackgroundResult,
  StudioOptions,
  BackgroundFill,
  CropPreset,
  FinalizeResult,
} from "./api/images";
export type {
  ConsoleArtisan,
  ConsoleArtisanDetail,
  ArtisanListResult,
  DashboardStats,
  DashboardSignupPoint,
  ModerationQueueResult,
  AuditLogEntry,
  FlaggedListing,
  FlaggedListingsResult,
} from "./api/console";
export type { PublicPassport } from "./api/passport";
export type { AnalyticsDailyPoint, AnalyticsListingStat, AnalyticsSummary } from "./api/analytics";

// importing utility apis
export { sendOtp, verifyOtp, OTP_LENGTH } from "./api/auth";
export { enhanceImage, removeImageBackground, finalizeImage } from "./api/images";
export { transcribeAndDescribe, translateText } from "./api/voice";
export { suggestPrice } from "./api/pricing";
export {
  createProduct,
  listProducts,
  updateProduct,
  setProductStock,
  deleteProduct,
  relocaliseProducts,
  searchMarketplace,
  getMarketplaceProduct,
} from "./api/products";
export { getMyProfile, updateMyProfile } from "./api/users";
export {
  createInquiry,
  listMyInquiries,
  listReceivedInquiries,
  closeInquiry,
  markInquiryResponded,
  replyToInquiry,
} from "./api/inquiries";
export {
  getDashboardStats,
  listArtisans,
  getArtisanDetail,
  setArtisanActive,
  getModerationQueue,
  approveListing,
  rejectListing,
  flagListing,
  deleteListing,
  getFlaggedListings,
  getAuditLog,
} from "./api/console";
export { getPublicPassport } from "./api/passport";
export { getAnalyticsSummary, recordProductView } from "./api/analytics";
