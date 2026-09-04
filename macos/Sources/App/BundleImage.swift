import SwiftUI

struct BundleImage: View {
  let name: String
  var body: some View {
    if let url = Bundle.main.url(forResource: name, withExtension: "png"),
      let image = NSImage(contentsOf: url)
    {
      Image(nsImage: image).resizable().scaledToFit()
    } else {
      Image(systemName: "photo").resizable().scaledToFit()
    }
  }
}
