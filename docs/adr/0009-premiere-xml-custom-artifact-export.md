# ADR 0009: Use FCP7 XML v4 for editable custom exports

Custom artifact export writes Final Cut Pro 7 `xmeml` v4 XML rather than an
undocumented native `.prproj`, AAF, or FCPXML file. Premiere Pro can import
this standard XML form; TTcut limits the interchange to one source video,
continuous V1/A1 clips, and editable source in/out points so that the generated
timeline remains predictable across the supported workflow.
