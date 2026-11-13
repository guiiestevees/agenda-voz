import Foundation
import UIKit
import AVFoundation
import EventKit
import Speech
import Capacitor
import WidgetKit
import PaywalloSDK

// Tela principal do app: registra os plugins próprios do Tap Bee
class TapBeeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NuvemPlugin())
        bridge?.registerPluginInstance(VozPlugin())
        bridge?.registerPluginInstance(BeeWidgetPlugin())
        bridge?.registerPluginInstance(MetricasPlugin())
        bridge?.registerPluginInstance(TelaPlugin())
        bridge?.registerPluginInstance(GravadorPlugin())
        bridge?.registerPluginInstance(CalendarioPlugin())
        // App nativo não dá zoom: um toque duplo sem querer mudava o tamanho da tela
        webView?.scrollView.minimumZoomScale = 1
        webView?.scrollView.maximumZoomScale = 1
        webView?.scrollView.bouncesZoom = false
    }
}

// ---------- iCloud: guarda uma cópia dos dados no iCloud de cada pessoa, sem login ----------
@objc(NuvemPlugin)
public class NuvemPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NuvemPlugin"
    public let jsName = "Nuvem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ler", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "guardar", returnType: CAPPluginReturnPromise),
    ]
    private let loja = NSUbiquitousKeyValueStore.default
    private let chave = "dados"
    private let limite = 1_000_000   // o iCloud aceita até 1 MB aqui; os dados vão comprimidos

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(mudou(_:)), name: NSUbiquitousKeyValueStore.didChangeExternallyNotification, object: loja)
        loja.synchronize()
    }

    @objc private func mudou(_ aviso: Notification) {
        let motivo = aviso.userInfo?[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int ?? -1
        notifyListeners("mudou", data: ["cheio": motivo == NSUbiquitousKeyValueStoreQuotaViolationChange])
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["conta": FileManager.default.ubiquityIdentityToken != nil])
    }

    @objc func ler(_ call: CAPPluginCall) {
        loja.synchronize()
        guard let dados = loja.data(forKey: chave) else { return call.resolve([:]) }
        guard let aberto = try? (dados as NSData).decompressed(using: .lzfse) as Data, let json = String(data: aberto, encoding: .utf8) else {
            return call.reject("Cópia do iCloud ilegível")
        }
        call.resolve(["json": json])
    }

    @objc func guardar(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let dados = json.data(using: .utf8),
              let fechado = try? (dados as NSData).compressed(using: .lzfse) as Data else {
            return call.reject("Dados inválidos")
        }
        if fechado.count > limite { return call.reject("cheio") }
        loja.set(fechado, forKey: chave)
        loja.synchronize()
        call.resolve(["tamanho": fechado.count])
    }
}

// ---------- Voz: reconhecimento de fala do próprio iPhone para o botão Falar ----------
@objc(VozPlugin)
public class VozPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VozPlugin"
    public let jsName = "Voz"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "iniciar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parar", returnType: CAPPluginReturnPromise),
    ]
    private var motor: AVAudioEngine?
    private var pedido: SFSpeechAudioBufferRecognitionRequest?
    private var tarefa: SFSpeechRecognitionTask?
    private var parando = false
    private var textoAnterior = ""

    @objc func iniciar(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { fala in
            AVAudioSession.sharedInstance().requestRecordPermission { microfone in
                DispatchQueue.main.async {
                    guard fala == .authorized, microfone else { return call.reject("not-allowed") }
                    let idioma = call.getString("idioma") ?? "pt-BR"
                    do {
                        try self.comecar(idioma: idioma)
                        call.resolve()
                    } catch {
                        // O áudio do iPhone às vezes ainda está sendo trocado: tenta de novo em seguida
                        print("[Voz] primeira tentativa falhou: \(error)")
                        self.encerrar()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                            do {
                                try self.comecar(idioma: idioma)
                                call.resolve()
                            } catch {
                                print("[Voz] segunda tentativa falhou: \(error)")
                                self.encerrar()
                                call.reject("indisponivel: \(error.localizedDescription)")
                            }
                        }
                    }
                }
            }
        }
    }

    @objc func parar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.parando = true
            self.pedido?.endAudio()
            if let motor = self.motor, motor.isRunning { motor.stop(); motor.inputNode.removeTap(onBus: 0) }
            call.resolve()
        }
    }

    private func comecar(idioma: String) throws {
        encerrar()
        parando = false
        textoAnterior = ""
        guard let reconhecedor = SFSpeechRecognizer(locale: Locale(identifier: idioma)), reconhecedor.isAvailable else {
            throw NSError(domain: "Voz", code: 1)
        }
        let sessao = AVAudioSession.sharedInstance()
        try sessao.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try sessao.setActive(true, options: .notifyOthersOnDeactivation)

        // O áudio é criado aqui, já no modo de gravação: criado antes, a entrada fica presa em 0 Hz
        let motor = AVAudioEngine()
        self.motor = motor
        let entrada = motor.inputNode
        let formato = entrada.outputFormat(forBus: 0)
        print("[Voz] entrada: \(formato.sampleRate) Hz, \(formato.channelCount) canal(is), disponível: \(sessao.isInputAvailable)")
        guard formato.sampleRate > 0, formato.channelCount > 0 else { throw NSError(domain: "Voz", code: 2) }
        entrada.installTap(onBus: 0, bufferSize: 1024, format: formato) { [weak self] buffer, _ in self?.pedido?.append(buffer) }
        motor.prepare()
        try motor.start()

        ouvir(com: reconhecedor)
    }

    private func ouvir(com reconhecedor: SFSpeechRecognizer) {
        let pedido = SFSpeechAudioBufferRecognitionRequest()
        pedido.shouldReportPartialResults = true
        self.pedido = pedido
        tarefa = reconhecedor.recognitionTask(with: pedido) { [weak self] resultado, erro in
            guard let self = self else { return }
            if let resultado = resultado {
                let texto = self.textoAnterior + resultado.bestTranscription.formattedString
                // O iPhone pode dar a frase por encerrada numa pausa: continua ouvindo até a pessoa terminar
                if resultado.isFinal && !self.parando {
                    self.notifyListeners("resultado", data: ["texto": texto, "final": false])
                    DispatchQueue.main.async {
                        guard !self.parando, self.motor != nil else { return }
                        self.textoAnterior = texto + " "
                        self.ouvir(com: reconhecedor)
                    }
                    return
                }
                self.notifyListeners("resultado", data: ["texto": texto, "final": resultado.isFinal])
            }
            if let erro = erro { print("[Voz] reconhecimento terminou com erro: \(erro)") }
            if erro != nil || resultado?.isFinal == true {
                DispatchQueue.main.async {
                    self.encerrar()
                    self.notifyListeners("fim", data: [:])
                }
            }
        }
    }

    private func encerrar() {
        if let motor = motor {
            if motor.isRunning { motor.stop() }
            motor.inputNode.removeTap(onBus: 0)
        }
        motor = nil
        pedido?.endAudio()
        tarefa?.cancel()
        pedido = nil
        tarefa = nil
        // Volta ao modo de reprodução: o som do Pomodoro continua com a tela bloqueada
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}

// ---------- Widget: passa os próximos compromissos para a tela de início ----------
@objc(BeeWidgetPlugin)
public class BeeWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BeeWidgetPlugin"
    public let jsName = "BeeWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "atualizar", returnType: CAPPluginReturnPromise),
    ]

    @objc func atualizar(_ call: CAPPluginCall) {
        let itens = call.getArray("itens", JSObject.self) ?? []
        guard let dados = try? JSONSerialization.data(withJSONObject: itens) else { return call.resolve() }
        let loja = UserDefaults(suiteName: "group.com.guiiestevees.tapbee")
        if loja?.data(forKey: "itens") != dados {
            loja?.set(dados, forKey: "itens")
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }
}

// ---------- Métricas: manda instalações, telas do quiz e quem comprou para o Paywallo ----------
// As compras continuam no RevenueCat; o Paywallo só mede. As notificações ficam com os lembretes da Bee.
@objc(MetricasPlugin)
public class MetricasPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MetricasPlugin"
    public let jsName = "Metricas"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "identificar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "etapa", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "concluir", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        Task {
            try? await PaywalloClient.shared.initialize(
                PaywalloInitConfig(appKey: "pk_fbd995148dfb41cbaef271060be87a08", notifications: false)
            )
        }
    }

    // O mesmo código anônimo vai para o RevenueCat, para cada venda ficar ligada à origem
    @objc func identificar(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { return call.resolve() }
        Task {
            try? await PaywalloClient.shared.identify(["userId": AnyCodable(id)])
            call.resolve()
        }
    }

    @objc func etapa(_ call: CAPPluginCall) {
        guard let nome = call.getString("nome"), !nome.isEmpty else { return call.resolve() }
        let ordem = call.getDouble("ordem") ?? 0
        Task {
            await PaywalloClient.shared.waitUntilReady()
            try? await PaywalloClient.shared.onboardingStep(stepName: nome, order: ordem)
            call.resolve()
        }
    }

    @objc func concluir(_ call: CAPPluginCall) {
        Task {
            await PaywalloClient.shared.waitUntilReady()
            try? await PaywalloClient.shared.onboardingComplete()
            call.resolve()
        }
    }
}

// ---------- Cor por trás do app: a mesma do fundo da tela, para nada piscar quando o teclado abre ----------
@objc(TelaPlugin)
public class TelaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TelaPlugin"
    public let jsName = "Tela"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fundo", returnType: CAPPluginReturnPromise),
    ]

    // Recebe "rgb(246, 245, 243)" do CSS
    @objc func fundo(_ call: CAPPluginCall) {
        let numeros = (call.getString("cor") ?? "").split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard numeros.count >= 3 else { return call.resolve() }
        let cor = UIColor(red: numeros[0] / 255, green: numeros[1] / 255, blue: numeros[2] / 255, alpha: 1)
        DispatchQueue.main.async { [weak self] in
            guard let web = self?.bridge?.webView else { return }
            web.isOpaque = false
            web.backgroundColor = cor
            web.scrollView.backgroundColor = cor
            self?.bridge?.viewController?.view.backgroundColor = cor
            call.resolve()
        }
    }
}

// ---------- Reuniões: grava com a tela bloqueada, em pedaços de 5 minutos que o app manda para transcrever ----------
public class GravadorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GravadorPlugin"
    public let jsName = "Gravador"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "iniciar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pausar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "continuar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ler", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apagar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "arquivos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "segurar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "soltar", returnType: CAPPluginReturnPromise),
    ]
    private let duracaoPedaco: TimeInterval = 300
    private var gravador: AVAudioRecorder?
    private var pasta: URL?
    private var pedacos = 0
    private var pausado = false
    private var relogio: Timer?

    // O áudio fica guardado no iPhone para ouvir depois (Application Support não é apagado pelo sistema).
    // Gravações antigas ficaram em Caches: se a pasta antiga existe, continua usando ela.
    private func pastaDe(_ id: String) -> URL {
        let fm = FileManager.default
        let antiga = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("reuniao-\(id)", isDirectory: true)
        if fm.fileExists(atPath: antiga.path) { return antiga }
        var base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Reunioes", isDirectory: true)
        if !fm.fileExists(atPath: base.path) {
            try? fm.createDirectory(at: base, withIntermediateDirectories: true)
            var v = URLResourceValues(); v.isExcludedFromBackup = true; try? base.setResourceValues(v)
        }
        return base.appendingPathComponent("reuniao-\(id)", isDirectory: true)
    }

    // Fala baixinha de longe vira um arquivo pequeno: AAC mono de 16 kHz, uns 15 MB por hora
    private func novoPedaco() throws {
        guard let pasta = pasta else { return }
        let ajustes: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue]
        let g = try AVAudioRecorder(url: pasta.appendingPathComponent("p\(pedacos).m4a"), settings: ajustes)
        guard g.record() else { throw NSError(domain: "Gravador", code: 1) }
        gravador = g
        pedacos += 1
    }

    private func trocarPedaco() {
        guard !pausado, let g = gravador else { return }
        g.stop()
        let pronto = pedacos - 1
        try? novoPedaco()
        notifyListeners("pedaco", data: ["indice": pronto])
    }

    @objc func iniciar(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? UUID().uuidString
        AVAudioSession.sharedInstance().requestRecordPermission { ok in
            DispatchQueue.main.async {
                guard ok else { return call.reject("not-allowed") }
                do {
                    let sessao = AVAudioSession.sharedInstance()
                    try sessao.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers])
                    try sessao.setActive(true)
                    self.pasta = self.pastaDe(id)
                    try FileManager.default.createDirectory(at: self.pasta!, withIntermediateDirectories: true)
                    self.pedacos = 0
                    self.pausado = false
                    try self.novoPedaco()
                    self.relogio?.invalidate()
                    self.relogio = Timer.scheduledTimer(withTimeInterval: self.duracaoPedaco, repeats: true) { [weak self] _ in self?.trocarPedaco() }
                    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
                    NotificationCenter.default.addObserver(self, selector: #selector(self.interrompido(_:)), name: AVAudioSession.interruptionNotification, object: nil)
                    call.resolve()
                } catch {
                    print("[Gravador] não começou: \(error)")
                    call.reject("indisponivel")
                }
            }
        }
    }

    // Uma ligação pausa a gravação; quando ela acaba, continua sozinha
    @objc private func interrompido(_ aviso: Notification) {
        guard let bruto = aviso.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: bruto) == .ended, !pausado, gravador != nil else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        gravador?.record()
    }

    @objc func pausar(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.pausado = true; self.gravador?.pause(); call.resolve() }
    }

    @objc func continuar(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.pausado = false; self.gravador?.record(); call.resolve() }
    }

    @objc func parar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.relogio?.invalidate(); self.relogio = nil
            self.gravador?.stop(); self.gravador = nil
            NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve(["pedacos": self.pedacos])
        }
    }

    // Um pedaço em base64 para o app mandar ao servidor; pedaço quase vazio volta em branco
    @objc func ler(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "", indice = call.getInt("indice") ?? 0
        let arquivo = pastaDe(id).appendingPathComponent("p\(indice).m4a")
        guard let dados = try? Data(contentsOf: arquivo) else { return call.reject("sem-arquivo") }
        call.resolve(["audio": dados.count < 4000 ? "" : dados.base64EncodedString()])
    }

    @objc func apagar(_ call: CAPPluginCall) {
        try? FileManager.default.removeItem(at: pastaDe(call.getString("id") ?? ""))
        call.resolve()
    }

    // Ao sair do app no meio da preparação do resumo, o iPhone dá uns segundos extras para terminar o envio
    private var tarefaFundo: UIBackgroundTaskIdentifier = .invalid
    @objc func segurar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.tarefaFundo != .invalid { return call.resolve() }
            self.tarefaFundo = UIApplication.shared.beginBackgroundTask(withName: "resumo-reuniao") { [weak self] in
                guard let self = self else { return }
                UIApplication.shared.endBackgroundTask(self.tarefaFundo); self.tarefaFundo = .invalid
            }
            call.resolve()
        }
    }
    @objc func soltar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.tarefaFundo != .invalid { UIApplication.shared.endBackgroundTask(self.tarefaFundo); self.tarefaFundo = .invalid }
            call.resolve()
        }
    }

    // Lista os pedaços da gravação, com o caminho e a duração de cada um, para o player do app
    @objc func arquivos(_ call: CAPPluginCall) {
        let pasta = pastaDe(call.getString("id") ?? "")
        var lista: [[String: Any]] = []
        var i = 0
        while true {
            let arq = pasta.appendingPathComponent("p\(i).m4a")
            guard FileManager.default.fileExists(atPath: arq.path) else { break }
            let dur = (try? AVAudioPlayer(contentsOf: arq))?.duration ?? 0
            if dur > 0.5 { lista.append(["caminho": arq.path, "dur": dur]) }
            i += 1
        }
        call.resolve(["arquivos": lista])
    }
}

// ---------- Calendário do iPhone: lê os compromissos (Apple, Google e outras contas) e copia os do Tap Bee ----------
public class CalendarioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalendarioPlugin"
    public let jsName = "Calendario"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "permissao", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarios", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "eventos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "salvar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apagar", returnType: CAPPluginReturnPromise),
    ]
    private let loja = EKEventStore()

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(mudou), name: .EKEventStoreChanged, object: loja)
    }
    @objc private func mudou() { notifyListeners("mudou", data: [:]) }

    private var liberado: Bool {
        let s = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) { return s == .fullAccess }
        return s == .authorized
    }

    private func hex(_ cor: CGColor?) -> String {
        guard let c = cor?.components, c.count >= 3 else { return "#888888" }
        return String(format: "#%02X%02X%02X", Int(c[0] * 255), Int(c[1] * 255), Int(c[2] * 255))
    }

    // pedir: false só diz se já tem permissão; true mostra o pedido do iPhone
    @objc func permissao(_ call: CAPPluginCall) {
        if liberado || !(call.getBool("pedir") ?? false) { return call.resolve(["ok": liberado]) }
        let fim: (Bool, Error?) -> Void = { ok, _ in self.loja.reset(); call.resolve(["ok": ok]) }
        if #available(iOS 17.0, *) { loja.requestFullAccessToEvents(completion: fim) } else { loja.requestAccess(to: .event, completion: fim) }
    }

    @objc func calendarios(_ call: CAPPluginCall) {
        guard liberado else { return call.reject("sem-permissao") }
        let lista = loja.calendars(for: .event).map { c -> [String: Any] in
            ["id": c.calendarIdentifier, "titulo": c.title, "conta": c.source.title, "cor": hex(c.cgColor), "escreve": c.allowsContentModifications]
        }
        call.resolve(["calendarios": lista, "padrao": loja.defaultCalendarForNewEvents?.calendarIdentifier ?? ""])
    }

    // Compromissos entre duas datas, sem os que o próprio Tap Bee copiou para lá
    @objc func eventos(_ call: CAPPluginCall) {
        guard liberado else { return call.reject("sem-permissao") }
        let de = Date(timeIntervalSince1970: (call.getDouble("de") ?? 0) / 1000)
        let ate = Date(timeIntervalSince1970: (call.getDouble("ate") ?? 0) / 1000)
        let busca = loja.predicateForEvents(withStart: de, end: ate, calendars: nil)
        let lista = loja.events(matching: busca).filter { $0.url?.scheme != "tapbee" }.map { e -> [String: Any] in
            ["id": "\(e.calendarItemIdentifier)@\(Int(e.startDate.timeIntervalSince1970))", "titulo": e.title ?? "", "inicio": e.startDate.timeIntervalSince1970 * 1000,
             "fim": e.endDate.timeIntervalSince1970 * 1000, "diaTodo": e.isAllDay, "agenda": e.calendar.title, "cor": hex(e.calendar.cgColor)]
        }
        call.resolve(["eventos": lista])
    }

    // Cria ou atualiza a cópia de um compromisso do Tap Bee; séries vão com a regra de repetição e os dias tirados
    @objc func salvar(_ call: CAPPluginCall) {
        guard liberado else { return call.reject("sem-permissao") }
        let tapId = call.getString("tapId") ?? UUID().uuidString
        let ev = call.getString("idExterno").flatMap { $0.isEmpty ? nil : loja.event(withIdentifier: $0) } ?? EKEvent(eventStore: loja)
        ev.title = call.getString("titulo") ?? ""
        ev.startDate = Date(timeIntervalSince1970: (call.getDouble("inicio") ?? 0) / 1000)
        ev.endDate = Date(timeIntervalSince1970: (call.getDouble("fim") ?? 0) / 1000)
        ev.calendar = call.getString("calendario").flatMap { loja.calendar(withIdentifier: $0) } ?? loja.defaultCalendarForNewEvents
        ev.url = URL(string: "tapbee://evento/\(tapId)")
        ev.recurrenceRules = nil
        if let r = call.getObject("repetir"), let freq = r["freq"] as? String {
            let dias = (r["dias"] as? [Int] ?? []).compactMap { EKWeekday(rawValue: $0 + 1) }.map { EKRecurrenceDayOfWeek($0) }
            let tipo: EKRecurrenceFrequency = freq == "diaria" ? .daily : freq == "mensal" ? .monthly : freq == "anual" ? .yearly : .weekly
            ev.recurrenceRules = [EKRecurrenceRule(recurrenceWith: tipo, interval: 1, daysOfTheWeek: tipo == .weekly && !dias.isEmpty ? dias : nil,
                                                   daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: nil)]
        }
        do {
            try loja.save(ev, span: .futureEvents, commit: true)
            let id = ev.eventIdentifier ?? ""
            // Dias tirados da série ("só neste domingo"): apaga só aquela ocorrência
            let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.locale = Locale(identifier: "en_US_POSIX")
            for dia in call.getArray("excecoes", String.self) ?? [] {
                guard let d = fmt.date(from: dia), let cal = ev.calendar else { continue }
                let busca = loja.predicateForEvents(withStart: d, end: d.addingTimeInterval(86400), calendars: [cal])
                for o in loja.events(matching: busca) where o.eventIdentifier == id { try? loja.remove(o, span: .thisEvent, commit: true) }
            }
            call.resolve(["idExterno": id])
        } catch {
            call.reject("nao-salvou: \(error.localizedDescription)")
        }
    }

    @objc func apagar(_ call: CAPPluginCall) {
        guard liberado else { return call.reject("sem-permissao") }
        if let id = call.getString("idExterno"), let ev = loja.event(withIdentifier: id) { try? loja.remove(ev, span: .futureEvents, commit: true) }
        call.resolve()
    }
}
