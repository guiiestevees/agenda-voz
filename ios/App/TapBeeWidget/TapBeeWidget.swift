import WidgetKit
import SwiftUI

// Widget da tela de início: mostra o próximo compromisso e chama a Bee com um toque
private let grupoApp = "group.com.guiiestevees.tapbee"
private let emPortugues = Locale.preferredLanguages.first?.hasPrefix("pt") ?? true

struct ItemAgenda: Decodable {
    let titulo: String
    let quando: String
    let fim: Double
}

struct EntradaBee: TimelineEntry {
    let date: Date
    let proximo: ItemAgenda?
}

struct FonteBee: TimelineProvider {
    private func itens() -> [ItemAgenda] {
        guard let dados = UserDefaults(suiteName: grupoApp)?.data(forKey: "itens"),
              let lista = try? JSONDecoder().decode([ItemAgenda].self, from: dados) else { return [] }
        return lista
    }

    func placeholder(in context: Context) -> EntradaBee {
        EntradaBee(date: Date(), proximo: ItemAgenda(titulo: emPortugues ? "Dentista" : "Dentist", quando: emPortugues ? "Quinta, às 3 da tarde" : "Thursday at 3:00 PM", fim: 0))
    }

    func getSnapshot(in context: Context, completion: @escaping (EntradaBee) -> Void) {
        let agora = Date().timeIntervalSince1970 * 1000
        completion(context.isPreview ? placeholder(in: context) : EntradaBee(date: Date(), proximo: itens().first { $0.fim > agora }))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<EntradaBee>) -> Void) {
        let agora = Date()
        let futuros = itens().filter { $0.fim > agora.timeIntervalSince1970 * 1000 }
        var entradas = [EntradaBee(date: agora, proximo: futuros.first)]
        for (i, item) in futuros.enumerated() {
            entradas.append(EntradaBee(date: Date(timeIntervalSince1970: item.fim / 1000), proximo: i + 1 < futuros.count ? futuros[i + 1] : nil))
        }
        completion(Timeline(entries: entradas, policy: .after(agora.addingTimeInterval(3600))))
    }
}

private struct BotaoFalar: View {
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "mic.fill").font(.system(size: 13, weight: .bold))
            Text(emPortugues ? "Falar" : "Talk").font(.system(size: 15, weight: .bold))
        }
        .foregroundColor(Color(red: 0.11, green: 0.09, blue: 0.0))
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(Color.white.opacity(0.9))
        .clipShape(Capsule())
    }
}

private struct TextoProximo: View {
    let item: ItemAgenda?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item == nil ? (emPortugues ? "Nada marcado" : "Nothing scheduled") : item!.titulo)
                .font(.system(size: 17, weight: .bold)).lineLimit(2)
            Text(item?.quando ?? (emPortugues ? "Toque e fale com a Bee" : "Tap and talk to Bee"))
                .font(.system(size: 13, weight: .medium)).lineLimit(2)
        }
        .foregroundColor(Color(red: 0.11, green: 0.09, blue: 0.0))
        .minimumScaleFactor(0.85)
    }
}

struct VisaoBee: View {
    @Environment(\.widgetFamily) private var familia
    let entrada: EntradaBee

    var body: some View {
        conteudo.modifier(FundoMel())
    }

    @ViewBuilder private var conteudo: some View {
        if familia == .systemSmall {
            VStack(alignment: .leading, spacing: 6) {
                Image("Bee").resizable().scaledToFit().frame(width: 34, height: 34)
                TextoProximo(item: entrada.proximo)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "tapbee://falar"))
        } else {
            HStack(spacing: 12) {
                Image("Bee").resizable().scaledToFit().frame(width: 58, height: 58)
                TextoProximo(item: entrada.proximo)
                Spacer(minLength: 0)
                Link(destination: URL(string: "tapbee://falar")!) { BotaoFalar() }
            }
            .widgetURL(URL(string: "tapbee://abrir"))
        }
    }
}

private struct FundoMel: ViewModifier {
    private let mel = LinearGradient(colors: [Color(red: 1, green: 0.85, blue: 0.47), Color(red: 0.95, green: 0.69, blue: 0.12)], startPoint: .top, endPoint: .bottom)
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.containerBackground(mel, for: .widget)
        } else {
            content.padding().frame(maxWidth: .infinity, maxHeight: .infinity).background(mel)
        }
    }
}

@main
struct TapBeeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TapBeeWidget", provider: FonteBee()) { VisaoBee(entrada: $0) }
            .configurationDisplayName("Tap Bee")
            .description(emPortugues ? "Veja o próximo compromisso e fale com a Bee." : "See your next event and talk to Bee.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}
