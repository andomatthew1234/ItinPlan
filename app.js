let attractionsData = [];
let conversationHistory = [];
let currentTripState = {
    destination: "", days: 3, pacing: "", focus: "", selectedPlaces: [], tabsData: null
};
let lastFailedFunction = null; 

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initModel();
    if (!localStorage.getItem('gemini_api_key') && localStorage.getItem('trial_mode') !== 'true') {
        openKeyModal();
    }
});

// --- Theme Management ---
function initTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('theme-btn').innerText = '☀️ Light Mode';
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
        document.getElementById('theme-btn').innerText = '🌙 Dark Mode';
    }
}
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    document.getElementById('theme-btn').innerText = newTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
}

// --- Model Sync & Trial Mode ---
function initModel() {
    if (localStorage.getItem('trial_mode') === 'true') {
        updateGlobalModel('gemini-2.5-flash-lite');
        document.querySelectorAll('.model-selector').forEach(s => s.disabled = true);
    } else {
        const defaultModel = localStorage.getItem('default_gemini_model') || 'gemini-2.5-flash';
        updateGlobalModel(defaultModel);
        document.querySelectorAll('.model-selector').forEach(s => s.disabled = false);
    }
}

function updateGlobalModel(modelName) {
    localStorage.setItem('default_gemini_model', modelName);
    document.getElementById('home-model-select').value = modelName;
    document.getElementById('select-model-select').value = modelName;
}

function getActiveModel() { return localStorage.getItem('default_gemini_model') || 'gemini-2.5-flash'; }

function activateTrialMode() {
    localStorage.setItem('trial_mode', 'true');
    initModel(); // Locks the model selectors to Lite
    closeModal('key-modal');
    alert("Trial mode activated! You can generate one free itinerary.");
}

// --- UI Navigation & Forms ---
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}
function switchTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    btnElement.classList.add('active');
}
function handleEnter(e, callback) { if (e.key === 'Enter') callback(); }

function handleEnterContinue(e) {
    if (e.key === 'Enter') showExtendedOptions();
}

function showExtendedOptions() {
    const destInput = document.getElementById('destination-input').value.trim();
    if (destInput !== '') {
        document.getElementById('extended-options').style.display = 'flex';
        document.getElementById('continue-btn').style.display = 'none';
    } else {
        alert("Please enter a destination first.");
    }
}

// --- Modals ---
function openKeyModal() {
    document.getElementById('api-key-input').value = localStorage.getItem('gemini_api_key') || '';
    document.getElementById('key-modal').classList.remove('hidden');
}
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function saveApiKey() {
    const key = document.getElementById('api-key-input').value.trim();
    if (key) { 
        localStorage.setItem('gemini_api_key', key); 
        localStorage.removeItem('trial_mode'); 
        initModel(); // Unlocks model selectors
        closeModal('key-modal'); 
    }
}

// Fetches either the user's local key or the hidden trial key from /api/api.txt
async function getApiKey() {
    if (localStorage.getItem('trial_mode') === 'true') {
        try {
            const response = await fetch('api/api.txt');
            if (!response.ok) throw new Error("Trial key missing");
            return (await response.text()).trim();
        } catch (e) {
            alert("Trial mode is currently unavailable. Please enter your own API key.");
            localStorage.removeItem('trial_mode');
            initModel();
            openKeyModal();
            return null;
        }
    }
    return localStorage.getItem('gemini_api_key');
}

// --- JSON Cleaner ---
function parseGeminiJSON(text) {
    try {
        let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleanText);
    } catch (e) {
        console.error("Failed to parse JSON response:", text);
        throw new Error("AI returned malformed data. Please try again.");
    }
}

// --- API Caller & Error Interceptor ---
async function callGemini(contents, jsonMode = false) {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error("Missing API Key");

    const activeModel = getActiveModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;
    const payload = { contents: contents };
    if (jsonMode) { payload.generationConfig = { responseMimeType: "application/json" }; }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        let parsedError;
        try { parsedError = JSON.parse(errText); } catch(e){}
        
        if (response.status === 503 || (parsedError && parsedError.error && parsedError.error.code === 503)) {
            throw { status: 503, message: "High demand throttling hook" };
        }
        
        if (response.status === 429 || (parsedError && parsedError.error && parsedError.error.code === 429)) {
            throw { status: 429, message: "Quota Exhausted hook" };
        }

        throw new Error(`Error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

// --- Recovery Actions ---
function retryFailedAction() { if (lastFailedFunction) lastFailedFunction(); }
function retryWithLighterModel() { updateGlobalModel('gemini-2.5-flash-lite'); if (lastFailedFunction) lastFailedFunction(); }
function cancelError() { closeModal('place-details-modal'); showScreen('screen-home'); }

// --- Phase 1: Fetch Attractions ---
async function fetchAttractions() {
    // Prevent users from starting a second trip if they are on trial mode
    if (localStorage.getItem('trial_mode') === 'true' && localStorage.getItem('trial_trip_completed') === 'true') {
        alert("You have completed your free trial trip! To plan another destination, please enter your own API key.");
        openKeyModal();
        return;
    }

    const destInput = document.getElementById('destination-input').value.trim();
    if (!destInput) return;
    
    currentTripState.destination = destInput;
    currentTripState.days = document.getElementById('days-input').value || 3;
    currentTripState.pacing = document.getElementById('style-input').value;
    currentTripState.focus = document.getElementById('focus-input').value.trim();

    lastFailedFunction = fetchAttractions; 
    showScreen('screen-loading-1');

    let prompt = `Generate a JSON array of 9 to 15 top places to visit for a tourist visiting "${currentTripState.destination}". `;
    if (currentTripState.focus) prompt += `Focus of trip: "${currentTripState.focus}". Ensure alignment. `;
    prompt += `CRITICAL: If the location "${currentTripState.destination}" is invalid, return an empty array []. Otherwise, return JSON array: [{"id": 1, "name": "Name", "description": "2-sentence desc.", "type": "Category"}]`;

    try {
        const responseText = await callGemini([{ parts: [{ text: prompt }] }], true);
        attractionsData = parseGeminiJSON(responseText);
        
        if (!attractionsData || attractionsData.length === 0) {
            showScreen('screen-not-found');
            return;
        }
        renderAttractionsGrid(attractionsData);
        showScreen('screen-select');
    } catch (error) {
        if (error.status === 503) showScreen('screen-error-demand');
        else if (error.status === 429) showScreen('screen-error-limit');
        else { console.error(error); showScreen('screen-not-found'); }
    }
}

function renderAttractionsGrid(items) {
    const grid = document.getElementById('attractions-grid');
    grid.innerHTML = '';
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'attraction-card';
        card.dataset.id = item.id;
        card.innerHTML = `<div class="card-header"><h3>${item.name}</h3><input type="checkbox" data-id="${item.id}"></div><p>${item.description}</p><span class="badge">${item.type}</span>`;
        card.addEventListener('click', (e) => {
            const cb = card.querySelector('input[type="checkbox"]');
            if (e.target !== cb) cb.checked = !cb.checked;
            card.classList.toggle('selected', cb.checked);
        });
        grid.appendChild(card);
    });
}

// --- Phase 2: Build Itinerary ---
async function buildItinerary() {
    const checkedBoxes = document.querySelectorAll('.attractions-grid input[type="checkbox"]:checked');
    if (checkedBoxes.length === 0) { alert("Please select at least one attraction!"); return; }

    lastFailedFunction = buildItinerary;
    showScreen('screen-loading-2');
    
    const selectedIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.id));
    currentTripState.selectedPlaces = attractionsData.filter(item => selectedIds.includes(item.id));
    
    let requestText = `Build a ${currentTripState.days}-day logical chronological daily itinerary schedule for ${currentTripState.destination} using ONLY the following chosen attractions:\n\n`;
    currentTripState.selectedPlaces.forEach(p => { requestText += `- ${p.name} (${p.type})\n`; });
    requestText += `\nPacing: ${currentTripState.pacing}. Days: ${currentTripState.days}. `;
    if (currentTripState.focus) requestText += `Focus tips on: "${currentTripState.focus}". `;
    requestText += `Return EXCLUSIVELY JSON: { "itinerary_html": "<h3>Day one - [Theme]</h3><ul><li><strong>[Time/Event]</strong>: [details]</li></ul>", "tips": ["Tip 1", "Tip 2"], "calendar_days": [ { "day_title": "Day 1", "events": [ {"time": "09:00 AM", "title": "Place Name", "type": "Category"} ] } ] }`;

    conversationHistory = [{ role: 'user', parts: [{ text: requestText }] }];

    try {
        const responseText = await callGemini(conversationHistory, true);
        conversationHistory.push({ role: 'model', parts: [{ text: responseText }] });
        
        currentTripState.tabsData = parseGeminiJSON(responseText);
        
        // Mark trial as consumed once they get their first itinerary
        if (localStorage.getItem('trial_mode') === 'true') {
            localStorage.setItem('trial_trip_completed', 'true');
        }

        renderFinalScreen(currentTripState);
        showScreen('screen-final');
    } catch (error) {
        if (error.status === 503) showScreen('screen-error-demand');
        else if (error.status === 429) showScreen('screen-error-limit');
        else { alert(`Error: ${error.message}`); showScreen('screen-select'); }
    }
}

// --- Render Logic ---
function renderFinalScreen(state) {
    const list = document.getElementById('selected-events-list');
    list.innerHTML = '';
    state.selectedPlaces.forEach(p => {
        list.innerHTML += `<div class="selected-item"><h4>${p.name}</h4><p>${p.type}</p></div>`;
    });

    const data = state.tabsData;
    document.getElementById('itinerary-output').innerHTML = data.itinerary_html || '<p>No itinerary data generated.</p>';
    
    const tipsContainer = document.getElementById('tips-output');
    tipsContainer.innerHTML = '';
    if (data.tips) data.tips.forEach(tip => { tipsContainer.innerHTML += `<li>${tip}</li>`; });

    const calContainer = document.getElementById('calendar-output');
    calContainer.innerHTML = '';
    if (data.calendar_days) {
        data.calendar_days.forEach((day, index) => {
            let dayHtml = `<div class="cal-day"><h3>${day.day_title}</h3><div class="cal-events-list" data-day-index="${index}">`;
            day.events.forEach((ev, evIndex) => {
                dayHtml += `<div class="cal-event-card" draggable="true" data-ev-index="${evIndex}"><div class="cal-time">${ev.time}</div><div class="cal-details"><strong>${ev.title}</strong><span>${ev.type || 'Activity'}</span></div></div>`;
            });
            dayHtml += `</div></div>`;
            calContainer.innerHTML += dayHtml;
        });
    }
    
    const regenBtn = document.getElementById('regen-dnd-btn');
    if(regenBtn) regenBtn.classList.add('hidden');
    
    initDragAndDrop();

    const placesGrid = document.getElementById('places-tab-grid');
    placesGrid.innerHTML = '';
    state.selectedPlaces.forEach(p => {
        const card = document.createElement('div');
        card.className = 'attraction-card';
        card.innerHTML = `<div class="card-header"><h3>${p.name}</h3></div><p>${p.description}</p><button class="btn btn-secondary" style="width:100%; margin-top:0.5rem;" onclick="generatePlaceDetails('${p.name}')">View Details</button>`;
        placesGrid.appendChild(card);
    });
}

// --- Phase 3: Tweak Itinerary (Standard Chat) ---
async function tweakItinerary() {
    const tweakInput = document.getElementById('tweak-input');
    const instruction = tweakInput.value.trim();
    if (!instruction) return;

    lastFailedFunction = tweakItinerary; 
    const tabContainer = document.getElementById('itinerary-output-container');
    const loadingBar = document.getElementById('tweak-loading');
    
    tabContainer.style.opacity = '0.4'; tabContainer.style.pointerEvents = 'none'; loadingBar.style.display = 'block';

    const fullInstruction = instruction + "\n\nCRITICAL: Return ONLY a JSON object matching the exact schema previously used (itinerary_html, tips, calendar_days).";
    conversationHistory.push({ role: 'user', parts: [{ text: fullInstruction }] });
    tweakInput.value = '';

    try {
        const updatedResponseText = await callGemini(conversationHistory, true);
        conversationHistory.push({ role: 'model', parts: [{ text: updatedResponseText }] });
        currentTripState.tabsData = parseGeminiJSON(updatedResponseText);
        renderFinalScreen(currentTripState);
    } catch (error) {
        if (error.status === 503) { conversationHistory.pop(); tweakInput.value = instruction; showScreen('screen-error-demand'); } 
        else if (error.status === 429) { conversationHistory.pop(); tweakInput.value = instruction; showScreen('screen-error-limit'); }
        else { alert(`Error: ${error.message}`); conversationHistory.pop(); }
    } finally {
        tabContainer.style.opacity = '1'; tabContainer.style.pointerEvents = 'auto'; loadingBar.style.display = 'none';
    }
}

// --- Save / Load Trips Engine ---
function saveCurrentTrip() {
    if (!currentTripState.destination) return;
    let savedTrips = JSON.parse(localStorage.getItem('saved_trips') || '[]');
    const tripToSave = { ...currentTripState, id: Date.now(), dateSaved: new Date().toLocaleDateString() };
    savedTrips.push(tripToSave);
    localStorage.setItem('saved_trips', JSON.stringify(savedTrips));
    alert("Trip successfully saved to your browser!");
}

function openSavedTripsModal() {
    const list = document.getElementById('saved-trips-list');
    list.innerHTML = '';
    let savedTrips = JSON.parse(localStorage.getItem('saved_trips') || '[]');
    
    if (savedTrips.length === 0) { list.innerHTML = '<p>No saved trips found.</p>'; }
    
    savedTrips.reverse().forEach(trip => {
        list.innerHTML += `
            <div class="saved-trip-card">
                <div class="saved-trip-info">
                    <h4>${trip.destination}</h4>
                    <p>${trip.days} Days • Saved on ${trip.dateSaved}</p>
                </div>
                <button class="btn btn-success" style="width: auto; margin-top:0;" onclick="loadSavedTrip(${trip.id})">Load</button>
            </div>
        `;
    });
    document.getElementById('saved-trips-modal').classList.remove('hidden');
}

function loadSavedTrip(id) {
    let savedTrips = JSON.parse(localStorage.getItem('saved_trips') || '[]');
    const trip = savedTrips.find(t => t.id === id);
    if (trip) {
        currentTripState = trip;
        renderFinalScreen(currentTripState);
        closeModal('saved-trips-modal');
        showScreen('screen-final');
    }
}

// --- HTML5 Drag and Drop Engine ---
let draggedElement = null;

function initDragAndDrop() {
    const cards = document.querySelectorAll('.cal-event-card');
    const lists = document.querySelectorAll('.cal-events-list');

    cards.forEach(card => {
        card.addEventListener('dragstart', function(e) {
            draggedElement = this;
            setTimeout(() => this.classList.add('dragging'), 0);
        });
        card.addEventListener('dragend', function() {
            this.classList.remove('dragging');
            draggedElement = null;
        });
    });

    lists.forEach(list => {
        list.addEventListener('dragover', function(e) {
            e.preventDefault();
            this.classList.add('drag-over');
            const afterElement = getDragAfterElement(this, e.clientY);
            if (afterElement == null) { this.appendChild(draggedElement); } 
            else { this.insertBefore(draggedElement, afterElement); }
        });
        list.addEventListener('dragleave', function() { this.classList.remove('drag-over'); });
        list.addEventListener('drop', function() { 
            this.classList.remove('drag-over'); 
            document.getElementById('regen-dnd-btn').classList.remove('hidden');
        });
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.cal-event-card:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) { return { offset: offset, element: child }; } 
        else { return closest; }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// --- Regenerate from Drag and Drop ---
async function regenerateFromDragDrop() {
    const dndBtn = document.getElementById('regen-dnd-btn');
    const tabContainer = document.getElementById('itinerary-output-container');
    
    lastFailedFunction = regenerateFromDragDrop;
    dndBtn.innerText = "⏳ Regenerating...";
    dndBtn.disabled = true;
    tabContainer.style.opacity = '0.4';

    let newOrderText = "I have manually dragged-and-dropped my itinerary to reorder it. Here is the EXACT new chronological order I want:\n";
    document.querySelectorAll('.cal-day').forEach((dayElem) => {
        let dayTitle = dayElem.querySelector('h3').innerText;
        newOrderText += `\n${dayTitle}:\n`;
        dayElem.querySelectorAll('.cal-event-card strong').forEach(eventElem => {
            newOrderText += `- ${eventElem.innerText}\n`;
        });
    });
    newOrderText += `\n\nCRITICAL: Return ONLY a JSON object matching the exact schema (itinerary_html, tips, calendar_days). Completely recalculate realistic times, and update the narrative HTML to strictly follow this exact new order.`;

    conversationHistory.push({ role: 'user', parts: [{ text: newOrderText }] });

    try {
        const updatedResponseText = await callGemini(conversationHistory, true);
        conversationHistory.push({ role: 'model', parts: [{ text: updatedResponseText }] });
        
        currentTripState.tabsData = parseGeminiJSON(updatedResponseText);
        renderFinalScreen(currentTripState);
    } catch (error) {
        if (error.status === 503) { conversationHistory.pop(); showScreen('screen-error-demand'); } 
        else if (error.status === 429) { conversationHistory.pop(); showScreen('screen-error-limit'); }
        else { alert(`Error updating schedule: ${error.message}`); conversationHistory.pop(); }
    } finally {
        tabContainer.style.opacity = '1';
        dndBtn.innerText = "🔁 Regenerate itinerary with tweaks";
        dndBtn.disabled = false;
        if(!document.getElementById('screen-error-demand').classList.contains('active') && !document.getElementById('screen-error-limit').classList.contains('active')){
             dndBtn.classList.add('hidden');
        }
    }
}

// --- Deep Dive Place Generation ---
async function generatePlaceDetails(placeName) {
    const modalContent = document.getElementById('place-details-content');
    modalContent.innerHTML = `<div class="spinner"></div><p style="text-align:center;">Gathering details for ${placeName}...</p>`;
    document.getElementById('place-details-modal').classList.remove('hidden');

    lastFailedFunction = () => generatePlaceDetails(placeName);

    const prompt = `Provide practical visitor details for the attraction "${placeName}" in "${currentTripState.destination}".
    If the user has a focus ("${currentTripState.focus}"), explain its relevance.
    Return strictly JSON matching this schema:
    {
      "name": "Name of Place",
      "description": "1 paragraph detailed overview.",
      "focus_relevance": "How it fits the focus (or N/A)",
      "estimated_cost": "Cost string (e.g. $20 USD, Free, etc)",
      "tickets": [{"name": "Standard Ticket", "url": "https://example.com"}]
    }`;

    try {
        const response = await callGemini([{ parts: [{ text: prompt }] }], true);
        const data = parseGeminiJSON(response);
        
        let html = `<h2>${data.name}</h2>
                    <div class="place-detail-section"><h3>Description</h3><p>${data.description}</p></div>
                    <div class="place-detail-section"><h3>Relevance to your trip</h3><p>${data.focus_relevance}</p></div>
                    <div class="place-detail-section"><h3>Estimated Cost</h3><p>${data.estimated_cost}</p></div>
                    <div class="place-detail-section"><h3>Tickets & Links</h3>`;
        
        if (data.tickets && data.tickets.length > 0) {
            data.tickets.forEach(t => { html += `<a href="${t.url}" target="_blank" class="ticket-link">${t.name}</a>`; });
        } else {
            html += `<p>No external ticket links found.</p>`;
        }
        html += `</div>`;
        modalContent.innerHTML = html;

    } catch (error) {
        if (error.status === 503) { closeModal('place-details-modal'); showScreen('screen-error-demand'); }
        else if (error.status === 429) { closeModal('place-details-modal'); showScreen('screen-error-limit'); }
        else { modalContent.innerHTML = `<p style="color:var(--error-text);">Failed to load details. ${error.message}</p>`; }
    }
}