export const ANALYSIS_PYTHON_VERSION = '3.12.13' as const;
export const ANALYSIS_TORCH_VERSION = '2.12.1' as const;
export const ANALYSIS_RUNTIME_ID = `${ANALYSIS_PYTHON_VERSION}-${ANALYSIS_TORCH_VERSION}` as const;

export const ANALYSIS_RUNTIME_VARIANTS = ['cpu', 'cu126', 'cu132'] as const;
export type AnalysisRuntimeVariant = typeof ANALYSIS_RUNTIME_VARIANTS[number];
export type CudaRuntimeVariant = Exclude<AnalysisRuntimeVariant, 'cpu'>;

export function isAnalysisRuntimeVariant(value: string): value is AnalysisRuntimeVariant {
  return (ANALYSIS_RUNTIME_VARIANTS as readonly string[]).includes(value);
}

export function cudaVariantForComputeCapability(capability: number): CudaRuntimeVariant | null {
  if (!Number.isFinite(capability) || capability < 0) return null;
  return capability >= 12 ? 'cu132' : 'cu126';
}

export function cudaArchitectureForComputeCapability(capability: number): string | null {
  if (!Number.isFinite(capability) || capability < 0) return null;
  const major = Math.floor(capability);
  const minor = Math.round((capability - major) * 10);
  return `sm_${major}${minor}`;
}

export function isCudaArchitectureSupported(capability: number, archList: readonly string[]): boolean {
  const architecture = cudaArchitectureForComputeCapability(capability);
  return architecture !== null && archList.includes(architecture);
}

export function analysisRuntimeDirectory(variant: AnalysisRuntimeVariant): string {
  return `analysis-runtime/${ANALYSIS_RUNTIME_ID}/${variant}`;
}

export function analysisRuntimePython(variant: AnalysisRuntimeVariant): string {
  return `${analysisRuntimeDirectory(variant)}/python.exe`;
}

export function expectedTorchVersion(variant: AnalysisRuntimeVariant): string {
  return `${ANALYSIS_TORCH_VERSION}+${variant}`;
}

export const ACTIVE_RUNTIME_MANIFEST = 'active-runtime.json' as const;
