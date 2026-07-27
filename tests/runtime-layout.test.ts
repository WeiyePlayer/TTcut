import { describe, expect, it } from 'vitest';
import {
  cudaArchitectureForComputeCapability,
  cudaVariantForComputeCapability,
  isCudaArchitectureSupported,
} from '../src/main/runtime-layout';

describe('CUDA runtime selection', () => {
  it('prefers cu132 for sm_120 and keeps older GPUs on cu126', () => {
    expect(cudaVariantForComputeCapability(12.0)).toBe('cu132');
    expect(cudaVariantForComputeCapability(8.9)).toBe('cu126');
  });

  it('matches capabilities against the compiled architecture list', () => {
    expect(cudaArchitectureForComputeCapability(12.0)).toBe('sm_120');
    expect(isCudaArchitectureSupported(12.0, ['sm_90', 'sm_120'])).toBe(true);
    expect(isCudaArchitectureSupported(12.0, ['sm_90'])).toBe(false);
  });
});
