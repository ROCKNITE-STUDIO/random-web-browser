const { app, BrowserWindow, BrowserView, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args))

let win
let views = []
let currentTab = -1
const sessionFile = path.join(app.getPath('userData'), 'session.json')

// ---- App Ready ----
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile(path.join(__dirname, 'tabs', 'index.html'))

  // Restaurer session
  if (fs.existsSync(sessionFile)) {
    try {
      const savedTabs = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
      if (savedTabs.length > 0) {
        savedTabs.forEach(tab => addTab(tab.urlOriginal))
      } else addTab('home')
    } catch (e) {
      console.error("Erreur restauration session :", e)
      addTab('home')
    }
  } else {
    addTab('home')
  }

  // ---- IPC ----
  // Gestion des onglets
  ipcMain.on('new-tab', () => addTab())
  ipcMain.on('switch-tab', (e, index) => switchTab(index))
  ipcMain.on('close-tab', (e, index) => closeTab(index))
  ipcMain.on('navigate-url', (e, url) => navigateTab(url))
  ipcMain.on('navigate-back', () => {
    if(currentTab >= 0 && views[currentTab].view.webContents.canGoBack())
      views[currentTab].view.webContents.goBack()
  })
  ipcMain.on('navigate-forward', () => {
    if(currentTab >= 0 && views[currentTab].view.webContents.canGoForward())
      views[currentTab].view.webContents.goForward()
  })
  ipcMain.on('navigate-reload', () => {
    if(currentTab >= 0)
      views[currentTab].view.webContents.reload()
  })

  ipcMain.on('link-clicked', (e, url) => {
    if(currentTab >= 0) {
      views[currentTab].view.webContents.loadURL(url)
    }
  })
  ipcMain.on('form-submitted', (e, url) => {
    if(currentTab >= 0) {
      views[currentTab].view.webContents.loadURL(url)
    }
  })

  // Sauvegarde session
  app.on('before-quit', () => {
    const tabsData = views.map(t => ({ urlOriginal: t.urlOriginal }))
    fs.writeFileSync(sessionFile, JSON.stringify(tabsData, null, 2))
  })
})

// ---- Fonctions ----
// Ajoute un nouvel onglet
async function addTab(url) {
  const view = new BrowserView({ webPreferences: { nodeIntegration: true, contextIsolation: false } })
  const [width, height] = win.getSize()
  view.setBounds({ x: 0, y: 70, width, height })
  view.setAutoResize({ width: true, height: true })

  const tab = { view, urlOriginal: url || 'home', urlResolved: null, urlDisplay: null, placeholderDomain: null }
  views.push(tab)
  currentTab = views.length - 1
  win.setBrowserView(view)

  view.webContents.on('did-navigate', (event, navUrl) => {
    if (tab.urlOriginal === 'home') {
      tab.urlDisplay = 'home'
    } else if (tab.placeholderUrlObj && tab.urlResolved) {
      try {
        const resolved = new URL(tab.urlResolved)
        const current = new URL(navUrl)
        // Si on reste sur la même origine que la cible DNS, on garde le placeholder
        if (current.origin === resolved.origin) {
          // Reconstruit l'URL affichée avec le placeholder d'origine
          tab.urlDisplay =
            tab.placeholderUrlObj.protocol + '//' +
            tab.placeholderUrlObj.host +
            current.pathname +
            current.search +
            current.hash
        } else {
          tab.urlDisplay = navUrl
        }
      } catch {
        tab.urlDisplay = navUrl
      }
    } else {
      tab.urlDisplay = navUrl
    }
    updateTabsUI()
  })
  view.webContents.on('did-navigate-in-page', (event, navUrl) => {
    if (tab.urlOriginal === 'home') {
      tab.urlDisplay = 'home'
    } else if (tab.placeholderUrlObj && tab.urlResolved) {
      try {
        const resolved = new URL(tab.urlResolved)
        const current = new URL(navUrl)
        if (current.origin === resolved.origin) {
          tab.urlDisplay =
            tab.placeholderUrlObj.protocol + '//' +
            tab.placeholderUrlObj.host +
            current.pathname +
            current.search +
            current.hash
        } else {
          tab.urlDisplay = navUrl
        }
      } catch {
        tab.urlDisplay = navUrl
      }
    } else {
      tab.urlDisplay = navUrl
    }
    updateTabsUI()
  })

  view.webContents.setWindowOpenHandler(({ url }) => {
    // Ouvre dans un nouvel onglet interne
    addTab(url)
    return { action: 'deny' }
  })

  view.webContents.on('new-window', (event, url) => {
    event.preventDefault()
    addTab(url)
  })

  await loadTab(tab)
  updateTabsUI()
}

// Navigue vers une URL dans l'onglet courant
async function navigateTab(url) {
  if(currentTab < 0) return
  const tab = views[currentTab]
  tab.urlOriginal = url
  await loadTab(tab)
  updateTabsUI()
}

// Charge l'URL dans l'onglet, avec résolution DNS custom si nécessaire
async function loadTab(tab, forcedURL = null) {
  let finalURL

  if(tab.urlOriginal === 'home') {
    finalURL = 'file://' + path.join(__dirname, 'home', 'index.html')
    tab.urlResolved = finalURL
    tab.urlDisplay = 'home'
    tab.placeholderDomain = null
    await tab.view.webContents.loadFile(path.join(__dirname, 'home', 'index.html'))
  } else {
    let tempURL = forcedURL || tab.urlOriginal

    // Ajoute le protocole si manquant
    if(!/^https?:\/\//i.test(tempURL)) tempURL = 'https://' + tempURL

    let usedCustomDNS = false
let placeholderUrlObj = null
try {
  const domain = new URL(tempURL).hostname
  // Vérifie avec le DNS custom
  const resp = await fetch(`http://141.145.220.162:8080/dns/${domain}.json`)
  if(resp.ok) {
    const data = await resp.json()
    if (data.target) {
      // Reconstruit l'URL finale en gardant le chemin, la query et le hash
      const orig = new URL(tempURL)
      const target = new URL(data.target)
      finalURL =
        target.protocol + '//' +
        target.host +
        orig.pathname +
        orig.search +
        orig.hash
      usedCustomDNS = true
      placeholderUrlObj = orig
    }
  }
} catch(e) {
  console.error("Erreur résolution DNS custom :", e)
}

if (!usedCustomDNS) {
  finalURL = tempURL
  placeholderUrlObj = null
}

tab.urlResolved = finalURL
tab.placeholderUrlObj = placeholderUrlObj

    await tab.view.webContents.loadURL(finalURL)

    // Injecte le script pour intercepter les liens et formulaires
    tab.view.webContents.executeJavaScript(`
      const { ipcRenderer } = require('electron');
      document.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          ipcRenderer.send('link-clicked', a.href);
        });
      });
      document.querySelectorAll('form').forEach(f => {
        f.addEventListener('submit', e => {
          e.preventDefault();
          ipcRenderer.send('form-submitted', f.action);
        });
      });
    `)
  }

  updateTabsUI()
}

// Change d'onglet
function switchTab(index) {
  if(views[index]) {
    currentTab = index
    win.setBrowserView(views[index].view)
    const [width, height] = win.getSize()
    views[index].view.setBounds({ x: 0, y: 70, width, height })
    updateTabsUI()
  }
}

// Ferme un onglet
function closeTab(index) {
  if(!views[index]) return
  const view = views[index].view
  const isCurrent = (index === currentTab)

  if(isCurrent) win.setBrowserView(null)
  view.webContents.destroy()
  views.splice(index, 1)

  if(views.length === 0) {
    currentTab = -1
    addTab('home')
  } else if(isCurrent) {
    currentTab = Math.max(0, index - 1)
    win.setBrowserView(views[currentTab].view)
    const [width, height] = win.getSize()
    views[currentTab].view.setBounds({ x: 0, y: 70, width, height })
  }

  updateTabsUI()
}

// Met à jour l'interface des onglets
function updateTabsUI() {
  if(!win) return
  const tabsData = views.map((t, i) => ({
    title: t.view.webContents.getTitle() || `Onglet ${i+1}`,
    index: i,
    urlOriginal: t.urlOriginal,
    urlResolved: t.urlResolved,
    urlDisplay: t.urlDisplay
  }))
  win.webContents.send('tabs-updated', tabsData, currentTab)
}
