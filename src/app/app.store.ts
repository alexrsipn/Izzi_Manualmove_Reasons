import { Injectable } from '@angular/core';
import {
  ApptManualMove,
  GetADailyExtractFileJSONResponse,
  GetAListDailyExtractFilesDateResponse,
  ListDailyExtractValidation,
  ManualMove,
} from './types/ofs-rest-api';
import { ComponentStore } from '@ngrx/component-store';
import { OfsApiPluginService } from './services/ofs-api-plugin.service';
import { OfsRestApiService } from './services/ofs-rest-api.service';
import { Message } from './types/plugin-api';
import {
  EMPTY,
  bufferCount,
  concatMap,
  delayWhen,
  from,
  interval,
  map,
  reduce,
  switchMap,
  tap,
  throttle,
  toArray,
} from 'rxjs';
import { DataRange } from './types/plugin';
import { parseStringPromise } from 'xml2js';
import { ExportService } from './services/export.service';
import { DialogService } from './services/dialog.service';
import * as XLSX from 'xlsx';

interface State {
  isLoading: boolean;
  selectedRange: DataRange;
  intervalDates: string[];
  ApptManualMoves: GetADailyExtractFileJSONResponse[];
  ManualMoves: any[];
  listDailyExtract?: ListDailyExtractValidation[];
  validatedDates: string[];
}

const initialState: State = {
  isLoading: false,
  selectedRange: { from: null, to: null, valid: false },
  intervalDates: [],
  ApptManualMoves: [
    {
      appt_manual_moves: {
        appt_manual_move: [],
      },
    },
  ],
  ManualMoves: [],
  validatedDates: [],
};

const chunkSize = 50000;

@Injectable({
  providedIn: 'root',
})
export class AppStore extends ComponentStore<State> {
  constructor(
    private readonly ofsPluginApi: OfsApiPluginService,
    private readonly ofsRestApi: OfsRestApiService,
    private readonly exportService: ExportService,
    private readonly dialogService: DialogService
  ) {
    super(initialState);
    this.handleOpenMessage(this.ofsPluginApi.openMessage$);
    this.ofsPluginApi.ready();
  }

  // Selectors
  private readonly isLoading$ = this.select((state) => state.isLoading);
  private readonly isDateRangeSelected = this.select(
    (state) => state.selectedRange
  );

  //View Model
  public readonly vm$ = this.select(
    this.isLoading$,
    this.isDateRangeSelected,
    (isLoading, isDateRangeSelected) => ({
      isLoading,
      isDateRangeSelected,
    })
  );

  // Updaters
  readonly setSelectedRange = this.updater<DataRange>(
    (state, selectedRange) => ({ ...state, selectedRange })
  );
  readonly setIntervalDates = this.updater<string[]>(
    (state, intervalDates) => ({
      ...state,
      intervalDates,
    })
  );
  readonly setValidatedDates = this.updater<string[]>(
    (state, validatedDates) => ({
      ...state,
      validatedDates,
    })
  );
  readonly setManualMovements = this.updater<string[]>(
    (state, ManualMoves) => ({
      ...state,
      ManualMoves,
    })
  );
  readonly setIsLoading = this.updater<boolean>((state, isLoading) => ({
    ...state,
    isLoading,
  }));

  // Effects
  private readonly handleOpenMessage = this.effect<Message>(($) =>
    $.pipe(
      tap(() => this.setIsLoading(true)),
      map(({ securedData }) => {
        const { ofscRestClientId, ofscRestSecretId, urlOFSC } = securedData;
        if (!ofscRestClientId || !ofscRestClientId || !urlOFSC) {
          throw new Error(
            'Los campos url, user y pass son requeridos para el correcto funcionamiento del plugin'
          );
        }
        this.ofsRestApi
          .setUrl(urlOFSC)
          .setCredentials({ user: ofscRestClientId, pass: ofscRestSecretId });
      }),
      tap(() => this.setIsLoading(false))
    )
  );

  private readonly exportManualMoveReasons = this.effect(($) =>
    $.pipe(
      tap(() => this.setIsLoading(true)),
      concatMap(() => this.listDailyExtract()),
      tap((response) => this.handleListDailyExtractFiles(response)),
      concatMap(() => this.dailyExtractFile()),
      switchMap((response) => this.handleDailyExtractFile(response)),
      concatMap((json) => this.handleJsonBody(json)),
      tap((json) => this.exportByChunks(json)),
      tap(() => this.dialogService.success('Archivo generado con éxito')),
      tap(() => this.setIsLoading(false))
    )
  );

  private readonly exportManualMoveReasonsByDay = this.effect(($) => $.pipe(
    tap(() => this.setIsLoading(true)),
    concatMap(() => this.listDailyExtract()),
    tap((response) => this.handleListDailyExtractFiles(response)),
    switchMap(() => this.dailyExtractFileByDay()),
    throttle(() => interval(1000)),
    tap(() => this.dialogService.success('Archivos generados con éxito')),
    tap(() => this.setIsLoading(false))
  ));

  public sendCloseMessage = this.effect<Partial<Message>>((data$) =>
    data$.pipe(tap((data) => this.ofsPluginApi.close(data)))
  );

  // Actions
  private exportByChunks(manualMoves: any[]) {
    from(manualMoves).pipe(
      bufferCount(chunkSize),
      concatMap((chunk) => {
        const worksheet: XLSX.WorkSheet = XLSX.utils.json_to_sheet(chunk);
        return Promise.resolve(worksheet);
      }),
      reduce((acc: XLSX.WorkBook, worksheet: XLSX.WorkSheet) => {
        if (!acc.Sheets) {
          acc = { Sheets: { movimientos: worksheet }, SheetNames: ['movimientos'] };
        } else {
          XLSX.utils.book_append_sheet(acc, worksheet, `movimientos_${Object.keys(acc.Sheets).length}`);
        }
        return acc;
      }, {} as XLSX.WorkBook),
      concatMap((workbook) => {
        const excelBuffer: any = XLSX.write(workbook, {
          bookType: 'xlsx',
          type: 'array',
        });
        return Promise.resolve(excelBuffer);
      })
    ).subscribe({
      next: (excelBuffer) => {
        this.exportService.saveAsExcelFile(excelBuffer, `MovMans_${this.get().selectedRange.from} a ${this.get().selectedRange.to}`);
      },
      error: (err) => {
        this.dialogService.error(err);
      },
      complete: () => {
        console.log('Complete, total: ' + manualMoves.length);
        this.clearBuffer();
      },
    });
    // from(ManualMoves).pipe(
    //   bufferCount(chunkSize),
    //   concatMap(chunk => {
    //     const worksheet: XLSX.WorkSheet = XLSX.utils.json_to_sheet(chunk);
    //     return Promise.resolve(worksheet);
    //   }),
    //   reduce((acc: XLSX.WorkBook, worksheet: XLSX.WorkSheet) => {
    //     if (!acc.Sheets) {
    //       acc = { Sheets: { movimientos: worksheet }, SheetNames: ['movimientos'] };
    //     } else {
    //       XLSX.utils.book_append_sheet(acc, worksheet, `movimientos_${Object.keys(acc.Sheets).length}`);
    //     }
    //     return acc;
    //   }, {} as XLSX.WorkBook),
    //   concatMap(workbook => {
    //     const excelBuffer: any = XLSX.write(workbook, {
    //       bookType: 'xlsx',
    //       type: 'array',
    //     });
    //     return Promise.resolve(excelBuffer);
    //   })
    // ).subscribe({
    //   next: (excelBuffer) => {
    //     this.exportService.saveAsExcelFile(excelBuffer, `MovMans_${this.get().selectedRange.from} a ${this.get().selectedRange.to}`);
    //   },
    //   error: (err) => {
    //     this.dialogService.error(err);
    //   },
    //   complete: () => {
    //     // console.log('Complete, total: ' + this.get().ManualMoves.length);
    //     this.clearBuffer();
    //   }
    // }
    // )
  }

  private listDailyExtract() {
    const { intervalDates } = this.get();
    return from(intervalDates).pipe(
      concatMap((date) =>
        this.ofsRestApi.getAListOfDailyExtractFilesForADate({
          dailyExtractDate: date,
        })
      ),
      toArray()
    );
  };

  private dailyExtractFile() {
    const { validatedDates } = this.get();
    return from(validatedDates).pipe(
      concatMap((date) => this.ofsRestApi.getADailyExtractFile(date)),
      toArray()
    );
  }

  private dailyExtractFileByDay() {
    const { validatedDates } = this.get();
    return from(validatedDates).pipe(
      concatMap((date) => this.ofsRestApi.getADailyExtractFile(date).pipe(
        map((response) => ({ response, date }))
      )),
      // tap(({ response }) => this.setManualMovements([response])),
      concatMap(({ response, date }) => this.handleDailyExtractFileByDay([response]).pipe(
        map((response) => ({ response, date }))
      )),
      // tap(({ response }) => this.handleJson(response)),
      tap(({ date }) => this.exportService.exportAsExcelFile(this.get().ManualMoves, `MovMans_${date}`)),
      tap(() => this.clearBufferByDay()),
    );
  }

  private handleDailyExtractFile(files: string[]) {
    return from(files).pipe(
      concatMap((file) => from(this.xmlToJson(file))),
      toArray()
    );
  }

  private handleDailyExtractFileByDay(files: string[]) {
    return from(files).pipe(
      delayWhen((file) => this.xmlToJson(file)),
      toArray()
    );
  }

  private handleJsonBody(json: GetADailyExtractFileJSONResponse[]) {
    return from(json).pipe(
      concatMap((json) => this.handleJsonTest(json)),
      toArray()
    );
  }

  private async xmlToJson(xml: string) {
    try {
      const json = await parseStringPromise(xml, {
        explicitArray: false,
        mergeAttrs: true,
      });
      return json;
    } catch (error) {
      console.error('Error parsing XML: ', error);
      // this.handleError({message: error, name: error})
      throw error;
    }
  }

  public descargarRazones() {
    this.setIsLoading(true);
    this.createRange();
    const { intervalDates } = this.get();
    // intervalDates.length > 8 ? this.exportManualMoveReasonsByDay() : this.exportManualMoveReasons();
    this.exportManualMoveReasons();
  }

  private handleListDailyExtractFiles(
    dailyExtractFilesList: GetAListDailyExtractFilesDateResponse[]
  ) {
    const regex = /\d{4}-\d{2}-\d{2}/;
    const arregloFechas: string[] = [];
    dailyExtractFilesList.map((fileByDate) => {
      if (fileByDate.files.items.length > 0) {
        fileByDate.files.items.map((item) => {
          if (item.name === 'appt_manual_move') {
            const fecha = item.links[0].href.match(regex);
            arregloFechas.push(fecha![0]);
          }
        });
      }
    });
    // arregloFechas.sort((a, b) => {
    //   const dateA = new Date(a);
    //   const dateB = new Date(b);
    //   return dateA.getTime() - dateB.getTime();
    // });
    this.setValidatedDates(arregloFechas);
  }

  private createRange() {
    const { selectedRange } = this.get();
    let fechas = [];
    let fechaActual = new Date(selectedRange.from!);
    let fechaFinal = new Date(selectedRange.to!);
    while (fechaActual <= fechaFinal) {
      fechas.push(fechaActual.toISOString().split('T')[0]);
      fechaActual.setDate(fechaActual.getDate() + 1);
    }
    this.setIntervalDates(fechas);
  }

  private handleJson() {
    const { ApptManualMoves } = this.get();
    const json: any[] = [];
    ApptManualMoves.map(({ appt_manual_moves }) => {
      if (Array.isArray(appt_manual_moves.appt_manual_move)) {
        appt_manual_moves.appt_manual_move.forEach(({ Field }) => {
          const newItem: { [key: string]: string | undefined } = {};
          Field.forEach((field) => {
            if (
              field.name === 'Condición de movimiento' ||
              field.name === 'Discrepancia de aptitud laboral' ||
              field.name === 'Discrepancia de zona de trabajo' ||
              field.name === 'Enrutado automático a fecha' ||
              field.name === 'Etiqueta de motivo de movimiento' ||
              field.name === 'Hora de acción de movimiento' ||
              field.name === 'ID de actividad' ||
              field.name === 'Mover a fecha' ||
              field.name === 'Mover de fecha' ||
              field.name === 'Nombre de motivo de movimiento' ||
              field.name === 'Nombre de usuario'
            ) {
              newItem[field.name] = field._;
            }
          });
          json.push(newItem);
          return newItem;
        });
      } else if (
        typeof appt_manual_moves.appt_manual_move === 'object' &&
        appt_manual_moves.appt_manual_move !== null
      ) {
        const arrayFromObject: ApptManualMove[] = [];
        arrayFromObject.push(appt_manual_moves.appt_manual_move);
        arrayFromObject.map(({ Field }) => {
          const newItem: { [key: string]: string | undefined } = {};
          Field.forEach((field) => {
            newItem[field.name] = field._;
          });
          json.push(newItem);
          return newItem;
        });
      }
    });
    this.setManualMovements(json);
  }

  private handleJsonTest(ApptManualMoves: GetADailyExtractFileJSONResponse) {
    const json: any[] = [];
    ApptManualMoves.appt_manual_moves.appt_manual_move.map(({ Field }) => {
      const newItem: { [key: string]: string | undefined } = {};
      Field.forEach((field) => {
        if (
          field.name === 'Condición de movimiento' ||
          field.name === 'Discrepancia de aptitud laboral' ||
          field.name === 'Discrepancia de zona de trabajo' ||
          field.name === 'Enrutado automático a fecha' ||
          field.name === 'Etiqueta de motivo de movimiento' ||
          field.name === 'Hora de acción de movimiento' ||
          field.name === 'ID de actividad' ||
          field.name === 'Mover a fecha' ||
          field.name === 'Mover de fecha' ||
          field.name === 'Nombre de motivo de movimiento' ||
          field.name === 'Nombre de usuario'
        ) {
          newItem[field.name] = field._;
        }
      });
      json.push(newItem);
      return newItem;
    });
    // ApptManualMoves.map(({ appt_manual_moves }) => {
    //   if (Array.isArray(appt_manual_moves.appt_manual_move)) {
    //     appt_manual_moves.appt_manual_move.forEach(({ Field }) => {
    //       const newItem: { [key: string]: string | undefined } = {};
    //       Field.forEach((field) => {
    //         if (
    //           field.name === 'Condición de movimiento' ||
    //           field.name === 'Discrepancia de aptitud laboral' ||
    //           field.name === 'Discrepancia de zona de trabajo' ||
    //           field.name === 'Enrutado automático a fecha' ||
    //           field.name === 'Etiqueta de motivo de movimiento' ||
    //           field.name === 'Hora de acción de movimiento' ||
    //           field.name === 'ID de actividad' ||
    //           field.name === 'Mover a fecha' ||
    //           field.name === 'Mover de fecha' ||
    //           field.name === 'Nombre de motivo de movimiento' ||
    //           field.name === 'Nombre de usuario'
    //         ) {
    //           newItem[field.name] = field._;
    //         }
    //       });
    //       json.push(newItem);
    //       return newItem;
    //     });
    //   } else if (
    //     typeof appt_manual_moves.appt_manual_move === 'object' &&
    //     appt_manual_moves.appt_manual_move !== null
    //   ) {
    //     const arrayFromObject: ApptManualMove[] = [];
    //     arrayFromObject.push(appt_manual_moves.appt_manual_move);
    //     arrayFromObject.map(({ Field }) => {
    //       const newItem: { [key: string]: string | undefined } = {};
    //       Field.forEach((field) => {
    //         newItem[field.name] = field._;
    //       });
    //       json.push(newItem);
    //       return newItem;
    //     });
    //   }
    // });
    return json;
  }

  private clearBuffer() {
    this.setManualMovements([]);
    this.setValidatedDates([]);
    this.setIntervalDates([]);
    this.setSelectedRange({ from: null, to: null, valid: false });
  }

  private clearBufferByDay() {
    this.setManualMovements([]);
  }

  private handleError(err: Error) {
    console.log('Error', err);
    alert('Hubo un error\n' + err.message || 'Error desconocido');
    return EMPTY;
  }
}
