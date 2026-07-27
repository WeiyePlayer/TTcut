# ADR 0004: Bounded CUDA analysis pipeline

## Status

Accepted

## Context

TrackNet analysis previously decoded and assembled one Batch, synchronously
copied it to CUDA, ran the model, copied the result back, and completed all CPU
postprocessing before decoding the next Batch. At production `batch=4`,
`seq_len=8`, `bg_mode=concat`, and `280x160`, one input Batch is about 18.5 MiB.
Per-sequence `concatenate` calls and a per-Batch `stack` also copied that data
more than once.

Running several model forwards concurrently would increase device-memory
pressure and can change scheduling without removing the CPU preparation
bottleneck. Unbounded prefetch would make memory usage depend on video length
and would complicate cancellation.

## Decision

CUDA analysis uses one bounded, ordered pipeline:

```text
CPU Producer -> Ready Queue (2) -> one GPU Consumer
             -> Result Queue (2) -> CPU Postprocessor
```

Three reusable Buffer Slots move through:

```text
FREE -> FILLING -> READY -> GPU_RUNNING
     -> RESULT_READY -> POSTPROCESSING -> FREE
```

The Producer decodes, crops, resizes, and writes directly into a Slot's final
Batch allocation. The GPU Consumer is the coordinating thread and enqueues only
one TrackNet forward at a time. The Postprocessor consumes Batch ordinals in
FIFO order and is the only owner of trajectory history and progress updates.
Queue operations use bounded waits and a shared stop event; the first error is
preserved and both worker threads are joined before return or rethrow.

CUDA Slots normally use persistent pinned input and output tensors. The
Producer writes through the pinned input tensor's NumPy view. A dedicated H2D
stream, one compute stream, two reusable device-input buffers, and per-Slot
CUDA Events enforce buffer ownership and permit H2D for the next Batch to
overlap the current forward. The Postprocessor synchronizes only the Event for
the Slot it is about to read. Pinned allocation failure before decoding starts
falls back to the same bounded pipeline with pageable memory and synchronous
transfers.

CPU analysis reuses direct Batch filling but remains serial. The implementation
uses only Python `threading`, `queue.Queue`, and PyTorch CUDA primitives; it
adds no Windows API, process, shared-memory, or external dependency.

## Consequences

- Batch order, model inputs, trajectory history, progress meaning, public
  Worker JSONL, and Electron IPC remain unchanged.
- Queue capacity and three Slot objects put a fixed upper bound on prefetched
  Host memory.
- A single model and compute stream avoid concurrent-forward VRAM spikes.
- Cancellation and errors cannot rely on blocking queue operations; every
  stage must observe the shared stop event and all threads must be joined.
- The pinned/Event layer is more complex and its isolated speed benefit was not
  demonstrated by the single formal run. It remains useful for explicit
  ownership and asynchronous transfer, while the performance report labels the
  measured change as uncertain.
- Windows 10 22H2 x64 and Windows 11 x64 Client keep the existing support
  boundary. This decision does not constitute Windows 10 hardware validation.
